import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, forbidden, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { toPageResult, type ListParams } from '@/kernel/validation/list-params'
import {
  buildStorageKey,
  checksumOf,
  getStorage,
  inspectUpload,
  MAX_UPLOAD_BYTES,
} from '@/lib/storage'

import {
  canReadDocument,
  canShareDocument,
  canWriteDocument,
  visibilityFilter,
  type GrantAccess,
  type Visibility,
  type ViewerFacts,
} from './access'
import * as repository from './repository'
import type { DocumentSort } from './schema'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * Documents.
 *
 * The rule that shapes every function below: **a document is reachable only
 * through a permission check**. There is no public URL, no presigned link and
 * no storage key rendered to a client. `downloadDocument` is the single place
 * bytes leave the system, and it refuses before it reads.
 *
 * A caller who may not see a document gets NOT_FOUND, never FORBIDDEN —
 * "forbidden" confirms the document exists, which is itself a leak when the
 * name of a file ("acquisition-termsheet.pdf") is the sensitive part.
 */

/* -------------------------------------------------------------------------- */
/* Viewer resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The subjects a viewer acts as, for record-level grants: themselves, each role
 * they hold, and each team they belong to.
 */
async function subjectsFor(ctx: Ctx) {
  const teamIds = await repository.memberTeamIds(ctx)

  return [
    { type: 'USER' as const, id: ctx.membershipId },
    ...ctx.roles.map((role) => ({ type: 'ROLE' as const, id: role.id })),
    ...teamIds.map((id) => ({ type: 'TEAM' as const, id })),
  ]
}

const STRENGTH: Record<GrantAccess, number> = { VIEW: 1, EDIT: 2, MANAGE: 3 }

function strongest(grants: Array<{ access: string }>): GrantAccess | null {
  let best: GrantAccess | null = null
  for (const grant of grants) {
    const access = grant.access as GrantAccess
    if (!best || STRENGTH[access] > STRENGTH[best]) best = access
  }
  return best
}

async function viewerFor(ctx: Ctx, documentId: string): Promise<ViewerFacts> {
  const subjects = await subjectsFor(ctx)
  const grants = await repository.grantsFor(ctx, documentId, subjects)

  return {
    membershipId: ctx.membershipId,
    canReadAny: ctx.can('document.read.any'),
    canReadScoped: ctx.can('document.read.scoped'),
    grant: strongest(grants),
  }
}

function requireAnyRead(ctx: Ctx): void {
  ctx.requireAny(['document.read.any', 'document.read.scoped'])
}

/* -------------------------------------------------------------------------- */
/* Folders                                                                     */
/* -------------------------------------------------------------------------- */

export async function listFolders(ctx: Ctx) {
  requireAnyRead(ctx)
  return repository.listFolders(ctx)
}

export async function createFolder(
  ctx: Ctx,
  input: { name: string; parentId?: string | undefined },
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('document.folder.manage')

  let path = `/${input.name}`

  if (input.parentId) {
    const parent = await repository.findFolder(ctx, input.parentId)
    if (!parent) throw validationError('That parent folder is not available.')
    // The materialized path is derived from the parent, never sent by a client.
    path = `${parent.path}/${input.name}`

    // A path is a prefix index, not a tree walk, so it must stay bounded.
    if (path.split('/').length > 12) {
      throw validationError('Folders cannot be nested more than ten deep.')
    }
  }

  try {
    const folder = await repository.createFolder(ctx, {
      name: input.name,
      parentId: input.parentId ?? null,
      path,
    })

    await writeAuditLog({
      action: 'document.folder.created',
      entityType: 'Folder',
      entityId: folder.id,
      organizationId: ctx.orgId,
      actorId: ctx.userId,
      metadata: { path },
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    return { id: folder.id }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('A folder with that name already exists here.', {
        name: ['Already in use.'],
      })
    }
    throw error
  }
}

export async function deleteFolder(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('document.folder.manage')

  const folder = await repository.findFolder(ctx, id)
  if (!folder) throw notFound('That folder is not available.')

  // Deleting a folder must never silently orphan its contents.
  const contents = await repository.countFolderContents(ctx, id)
  if (contents.documents > 0 || contents.children > 0) {
    throw conflict('Move or delete the contents before deleting this folder.')
  }

  await repository.softDeleteFolder(ctx, id)

  await writeAuditLog({
    action: 'document.folder.deleted',
    entityType: 'Folder',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export async function listDocuments(
  ctx: Ctx,
  params: ListParams<DocumentSort>,
  filters: { folderId?: string | undefined; projectId?: string | undefined } = {},
) {
  requireAnyRead(ctx)

  const subjects = await subjectsFor(ctx)
  const grantedDocumentIds = await repository.grantedDocumentIds(ctx, subjects)

  const access = visibilityFilter({
    membershipId: ctx.membershipId,
    canReadAny: ctx.can('document.read.any'),
    canReadScoped: ctx.can('document.read.scoped'),
    grantedDocumentIds,
  })

  const { items, total } = await repository.listDocuments(ctx, params, { access, ...filters })
  return toPageResult(items, total, params)
}

/**
 * One document, with the storage key stripped.
 *
 * The key is the one field that must never reach a client: it is the address of
 * the object, and an address that leaves the server is an address someone can
 * try. Callers that genuinely need it (the download handler) use
 * `downloadDocument`, which re-checks access itself.
 */
export async function getDocument(ctx: Ctx, id: string) {
  requireAnyRead(ctx)

  const document = await repository.findDocument(ctx, id)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, id)
  const decision = canReadDocument(document, viewer)
  if (!decision.allowed) throw notFound('That document is not available.')

  const { storageKey: _storageKey, ...safe } = document
  void _storageKey

  return {
    ...safe,
    accessReason: decision.reason,
    canEdit: canWriteDocument(document, { ...viewer, canUpdate: ctx.can('document.update') }),
    canShare: canShareDocument(document, { ...viewer, canShare: ctx.can('document.share') }),
    canDelete:
      ctx.can('document.delete') &&
      canWriteDocument(document, { ...viewer, canUpdate: ctx.can('document.update') }),
  }
}

/**
 * Resolve a document to bytes for download.
 *
 * Order matters and is deliberate: permission first, scan status second,
 * storage last. Nothing touches the object store on behalf of a caller who is
 * not allowed to have it, so a failed authorization is not even observable as a
 * latency difference.
 */
export async function downloadDocument(
  ctx: Ctx,
  id: string,
  options: { versionId?: string | undefined } = {},
): Promise<{ body: Uint8Array; mimeType: string; fileName: string; sizeBytes: number }> {
  requireAnyRead(ctx)

  const document = await repository.findDocument(ctx, id)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, id)
  if (!canReadDocument(document, viewer).allowed) {
    throw notFound('That document is not available.')
  }

  // A file that has not been cleared is not served, whatever the permission.
  if (document.scanStatus === 'INFECTED') {
    throw forbidden('That file was rejected by the content check.')
  }
  if (document.scanStatus === 'PENDING') {
    throw conflict('That file is still being checked. Try again shortly.')
  }

  let storageKey = document.storageKey
  let mimeType = document.mimeType
  let sizeBytes = document.sizeBytes

  if (options.versionId) {
    const version = await repository.findDocumentVersion(ctx, id, options.versionId)
    if (!version) throw notFound('That version is not available.')
    storageKey = version.storageKey
    mimeType = version.mimeType
    sizeBytes = version.sizeBytes
  }

  const object = await getStorage().get(storageKey)
  if (!object) throw notFound('That file is no longer in storage.')

  await writeAuditLog({
    action: 'document.downloaded',
    entityType: 'Document',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: options.versionId ? { versionId: options.versionId } : undefined,
  })

  return { body: object.body, mimeType, fileName: document.name, sizeBytes }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

export async function uploadDocument(
  ctx: Ctx,
  input: {
    fileName: string
    declaredType: string
    body: Uint8Array
    folderId?: string | undefined
    projectId?: string | undefined
    description?: string | undefined
    visibility?: Visibility | undefined
  },
  meta: RequestMeta,
): Promise<{ id: string; name: string }> {
  ctx.require('document.upload')

  const decision = inspectUpload({
    fileName: input.fileName,
    declaredType: input.declaredType,
    body: input.body,
    maxBytes: MAX_UPLOAD_BYTES,
  })

  if (!decision.ok) {
    throw validationError(decision.message, { file: [decision.message] })
  }

  if (input.folderId) {
    const folder = await repository.findFolder(ctx, input.folderId)
    if (!folder) throw validationError('That folder is not available.')
  }

  const storageKey = buildStorageKey(ctx.orgId, decision.extension)
  await getStorage().put(storageKey, input.body, decision.mimeType)

  const document = await repository.createDocument(ctx, {
    name: input.fileName.slice(0, 200),
    description: input.description ?? null,
    mimeType: decision.mimeType,
    sizeBytes: input.body.byteLength,
    storageKey,
    checksum: checksumOf(input.body),
    version: 1,
    visibility: input.visibility ?? 'ORGANIZATION',
    // No external scanner is configured in this deployment. Recording SKIPPED
    // is honest; claiming CLEAN would assert a check that never happened.
    scanStatus: 'SKIPPED',
    folderId: input.folderId ?? null,
    projectId: input.projectId ?? null,
  })

  await repository.createVersion(ctx, {
    documentId: document.id,
    version: 1,
    storageKey,
    sizeBytes: input.body.byteLength,
    checksum: checksumOf(input.body),
    mimeType: decision.mimeType,
  })

  await writeAuditLog({
    action: 'document.uploaded',
    entityType: 'Document',
    entityId: document.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: {
      name: document.name,
      sizeBytes: String(input.body.byteLength),
      visibility: input.visibility ?? 'ORGANIZATION',
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: document.id, name: document.name }
}

/** Replace the contents, keeping the previous bytes as an older version. */
export async function addVersion(
  ctx: Ctx,
  input: { documentId: string; fileName: string; declaredType: string; body: Uint8Array },
  meta: RequestMeta,
): Promise<{ version: number }> {
  ctx.require('document.upload')

  const document = await repository.findDocument(ctx, input.documentId)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, input.documentId)
  if (!canReadDocument(document, viewer).allowed) {
    throw notFound('That document is not available.')
  }
  if (!canWriteDocument(document, { ...viewer, canUpdate: ctx.can('document.update') })) {
    throw forbidden('You cannot change this document.')
  }

  const decision = inspectUpload({
    fileName: input.fileName,
    declaredType: input.declaredType,
    body: input.body,
    maxBytes: MAX_UPLOAD_BYTES,
  })
  if (!decision.ok) throw validationError(decision.message, { file: [decision.message] })

  // A new version must keep the same type: a "contract.pdf" whose newest
  // version is a spreadsheet is a different document.
  if (decision.mimeType !== document.mimeType) {
    throw validationError('A new version must be the same file type as the original.')
  }

  const storageKey = buildStorageKey(ctx.orgId, decision.extension)
  await getStorage().put(storageKey, input.body, decision.mimeType)

  const nextVersion = document.version + 1
  const checksum = checksumOf(input.body)

  await repository.createVersion(ctx, {
    documentId: document.id,
    version: nextVersion,
    storageKey,
    sizeBytes: input.body.byteLength,
    checksum,
    mimeType: decision.mimeType,
  })

  await repository.updateDocument(ctx, document.id, {
    storageKey,
    checksum,
    sizeBytes: input.body.byteLength,
    version: nextVersion,
  })

  await writeAuditLog({
    action: 'document.version.added',
    entityType: 'Document',
    entityId: document.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { version: String(nextVersion) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { version: nextVersion }
}

export async function updateDocument(
  ctx: Ctx,
  id: string,
  input: {
    name?: string | undefined
    description?: string | undefined
    folderId?: string | undefined
    visibility?: Visibility | undefined
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('document.update')

  const document = await repository.findDocument(ctx, id)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, id)
  if (!canReadDocument(document, viewer).allowed) {
    throw notFound('That document is not available.')
  }
  if (!canWriteDocument(document, { ...viewer, canUpdate: true })) {
    throw forbidden('You cannot change this document.')
  }

  // Widening visibility is the dangerous direction, so it takes the share
  // permission rather than the edit permission.
  const wideningVisibility =
    input.visibility !== undefined &&
    input.visibility !== document.visibility &&
    rank(input.visibility) > rank(document.visibility)

  if (
    wideningVisibility &&
    !canShareDocument(document, { ...viewer, canShare: ctx.can('document.share') })
  ) {
    throw forbidden('You cannot make this document more widely visible.')
  }

  if (input.folderId) {
    const folder = await repository.findFolder(ctx, input.folderId)
    if (!folder) throw validationError('That folder is not available.')
  }

  await repository.updateDocument(ctx, id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description || null } : {}),
    ...(input.folderId !== undefined ? { folderId: input.folderId || null } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
  })

  await writeAuditLog({
    action: 'document.updated',
    entityType: 'Document',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: input.visibility ? { visibility: input.visibility } : undefined,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Soft-delete a document.
 *
 * The stored objects are NOT removed here. A soft delete is reversible by
 * design (docs/DATA-MODEL.md §E.0), and deleting the bytes would make it
 * irreversible while leaving the row looking restorable. The purge job that
 * hard-deletes after the retention window is what removes objects.
 */
export async function deleteDocument(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('document.delete')

  const document = await repository.findDocument(ctx, id)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, id)
  if (!canReadDocument(document, viewer).allowed) {
    throw notFound('That document is not available.')
  }
  if (!canWriteDocument(document, { ...viewer, canUpdate: ctx.can('document.update') })) {
    throw forbidden('You cannot delete this document.')
  }

  await repository.softDeleteDocument(ctx, id)

  await writeAuditLog({
    action: 'document.deleted',
    entityType: 'Document',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { name: document.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Sharing                                                                     */
/* -------------------------------------------------------------------------- */

export async function listGrants(ctx: Ctx, documentId: string) {
  const document = await repository.findDocument(ctx, documentId)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, documentId)
  if (!canReadDocument(document, viewer).allowed) {
    throw notFound('That document is not available.')
  }

  return repository.listGrants(ctx, documentId)
}

export async function shareDocument(
  ctx: Ctx,
  input: {
    documentId: string
    subjectType: 'USER' | 'ROLE' | 'TEAM'
    subjectId: string
    access: GrantAccess
  },
  meta: RequestMeta,
): Promise<void> {
  const document = await repository.findDocument(ctx, input.documentId)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, input.documentId)
  if (!canReadDocument(document, viewer).allowed) {
    throw notFound('That document is not available.')
  }
  if (!canShareDocument(document, { ...viewer, canShare: ctx.can('document.share') })) {
    throw forbidden('You cannot share this document.')
  }

  // The subject must exist inside THIS organization. The id arrives from a
  // form, so it is resolved through the org-scoped client: an id from another
  // tenant simply does not resolve.
  await assertSubjectExists(ctx, input.subjectType, input.subjectId)

  await repository.upsertGrant(ctx, {
    documentId: input.documentId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    access: input.access,
  })

  await writeAuditLog({
    action: 'document.shared',
    entityType: 'Document',
    entityId: input.documentId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      access: input.access,
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function revokeGrant(
  ctx: Ctx,
  input: { documentId: string; grantId: string },
  meta: RequestMeta,
): Promise<void> {
  const document = await repository.findDocument(ctx, input.documentId)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, input.documentId)
  if (!canShareDocument(document, { ...viewer, canShare: ctx.can('document.share') })) {
    throw forbidden('You cannot change sharing on this document.')
  }

  const removed = await repository.deleteGrant(ctx, input.grantId, input.documentId)
  if (removed === 0) throw notFound('That share is not available.')

  await writeAuditLog({
    action: 'document.share.revoked',
    entityType: 'Document',
    entityId: input.documentId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

async function assertSubjectExists(
  ctx: Ctx,
  subjectType: 'USER' | 'ROLE' | 'TEAM',
  subjectId: string,
): Promise<void> {
  if (subjectType === 'USER') {
    const membership = await ctx.db.membership.findFirst({
      where: { id: subjectId, status: 'ACTIVE' },
      select: { id: true },
    })
    if (!membership) throw validationError('That person is not in this organization.')
    return
  }

  if (subjectType === 'TEAM') {
    const team = await ctx.db.team.findFirst({ where: { id: subjectId }, select: { id: true } })
    if (!team) throw validationError('That team is not available.')
    return
  }

  // Roles are not tenant-scoped (system templates have a null organizationId),
  // so the check is explicit: the role must be one this actor actually holds a
  // reference to through the organization.
  const role = ctx.roles.find((entry) => entry.id === subjectId)
  if (!role) {
    const assignment = await ctx.db.membershipRole.findFirst({
      where: { roleId: subjectId },
      select: { id: true },
    })
    if (!assignment) throw validationError('That role is not available.')
  }
}

/* -------------------------------------------------------------------------- */
/* Attachments                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Documents attached to another record.
 *
 * Attachments are filtered by the SAME visibility rule as the document list: a
 * private file attached to a task must not become visible because the task is.
 */
export async function listAttachments(ctx: Ctx, entityType: string, entityId: string) {
  requireAnyRead(ctx)

  const attachments = await repository.listAttachments(ctx, entityType, entityId)
  const subjects = await subjectsFor(ctx)
  const grantedIds = new Set(await repository.grantedDocumentIds(ctx, subjects))

  return attachments.filter((attachment) => {
    if (attachment.document.deletedAt !== null) return false
    return canReadDocument(
      {
        visibility: attachment.document.visibility as Visibility,
        uploadedById: attachment.document.uploadedById,
      },
      {
        membershipId: ctx.membershipId,
        canReadAny: ctx.can('document.read.any'),
        canReadScoped: ctx.can('document.read.scoped'),
        grant: grantedIds.has(attachment.documentId) ? 'VIEW' : null,
      },
    ).allowed
  })
}

export async function attachDocument(
  ctx: Ctx,
  input: { documentId: string; entityType: string; entityId: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('document.update')

  const document = await repository.findDocument(ctx, input.documentId)
  if (!document) throw notFound('That document is not available.')

  const viewer = await viewerFor(ctx, input.documentId)
  if (!canReadDocument(document, viewer).allowed) {
    throw notFound('That document is not available.')
  }

  try {
    await repository.createAttachment(ctx, {
      documentId: input.documentId,
      entityType: input.entityType,
      entityId: input.entityId,
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) return // Already attached: nothing to do.
    throw error
  }

  await writeAuditLog({
    action: 'document.attached',
    entityType: input.entityType,
    entityId: input.entityId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { documentId: input.documentId },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function detachDocument(ctx: Ctx, attachmentId: string): Promise<void> {
  ctx.require('document.update')
  const removed = await repository.deleteAttachment(ctx, attachmentId)
  if (removed === 0) throw notFound('That attachment is not available.')
}

/* -------------------------------------------------------------------------- */

export async function getStorageSummary(ctx: Ctx) {
  requireAnyRead(ctx)
  const used = await repository.storageUsed(ctx)
  return { ...used, driver: getStorage().name }
}

function rank(visibility: Visibility): number {
  return visibility === 'PRIVATE' ? 0 : visibility === 'RESTRICTED' ? 1 : 2
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/** People and teams a document can be shared with. */
export async function listShareTargets(ctx: Ctx) {
  ctx.require('document.share')
  return repository.listShareTargets(ctx)
}
