import type { Ctx } from '@/kernel/tenancy/ctx'
import { containsInsensitive, type ListParams } from '@/kernel/validation/list-params'

import type { DocumentSort } from './schema'

const live = { deletedAt: null }

/* --------------------------------- folders -------------------------------- */

export async function listFolders(ctx: Ctx) {
  return ctx.db.folder.findMany({
    where: live,
    orderBy: { path: 'asc' },
    select: {
      id: true,
      name: true,
      parentId: true,
      path: true,
      _count: { select: { documents: true } },
    },
  })
}

export async function findFolder(ctx: Ctx, id: string) {
  return ctx.db.folder.findFirst({
    where: { id, ...live },
    select: { id: true, name: true, parentId: true, path: true },
  })
}

export async function createFolder(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.folder.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.membershipId } as never,
    select: { id: true, name: true, path: true },
  })
}

export async function countFolderContents(ctx: Ctx, folderId: string) {
  const [documents, children] = await Promise.all([
    ctx.db.document.count({ where: { folderId, ...live } }),
    ctx.db.folder.count({ where: { parentId: folderId, ...live } }),
  ])
  return { documents, children }
}

export async function softDeleteFolder(ctx: Ctx, id: string) {
  const result = await ctx.db.folder.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

/* -------------------------------- documents ------------------------------- */

const documentListSelect = {
  id: true,
  name: true,
  description: true,
  mimeType: true,
  sizeBytes: true,
  version: true,
  visibility: true,
  scanStatus: true,
  createdAt: true,
  updatedAt: true,
  uploadedById: true,
  folder: { select: { id: true, name: true, path: true } },
  project: { select: { id: true, key: true } },
  uploadedBy: { select: { id: true, user: { select: { name: true } } } },
} as const

export async function listDocuments(
  ctx: Ctx,
  params: ListParams<DocumentSort>,
  filters: {
    /** Visibility clause built by `access.visibilityFilter`. */
    access: Record<string, unknown>
    folderId?: string | undefined
    projectId?: string | undefined
  },
) {
  const where = {
    ...live,
    ...filters.access,
    ...(filters.folderId ? { folderId: filters.folderId } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(params.q
      ? {
          AND: [
            {
              OR: [
                { name: containsInsensitive(params.q) },
                { description: containsInsensitive(params.q) },
              ],
            },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.document.findMany({
      where: where as never,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: documentListSelect,
    }),
    ctx.db.document.count({ where: where as never }),
  ])

  return { items, total }
}

/** The row itself, with no access filtering — the service decides. */
export async function findDocument(ctx: Ctx, id: string) {
  return ctx.db.document.findFirst({
    where: { id, ...live },
    select: {
      ...documentListSelect,
      storageKey: true,
      checksum: true,
      scanNote: true,
      companyId: true,
      projectId: true,
      folderId: true,
      versions: {
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          sizeBytes: true,
          mimeType: true,
          createdAt: true,
          uploadedBy: { select: { user: { select: { name: true } } } },
        },
      },
    },
  })
}

export async function findDocumentVersion(ctx: Ctx, documentId: string, versionId: string) {
  return ctx.db.documentVersion.findFirst({
    where: { id: versionId, documentId },
    select: { id: true, version: true, storageKey: true, mimeType: true, sizeBytes: true },
  })
}

export async function createDocument(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.document.create({
    data: { ...data, organizationId: ctx.orgId, uploadedById: ctx.membershipId } as never,
    select: { id: true, name: true, version: true },
  })
}

export async function updateDocument(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.document.updateMany({
    where: { id, ...live },
    data: data as never,
  })
  return result.count
}

export async function softDeleteDocument(ctx: Ctx, id: string) {
  const result = await ctx.db.document.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

export async function createVersion(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.documentVersion.create({
    data: { ...data, organizationId: ctx.orgId, uploadedById: ctx.membershipId } as never,
    select: { id: true, version: true },
  })
}

export async function listVersionKeys(ctx: Ctx, documentId: string) {
  return ctx.db.documentVersion.findMany({
    where: { documentId },
    select: { id: true, storageKey: true },
  })
}

/* --------------------------------- grants --------------------------------- */

const DOCUMENT_RESOURCE = 'DOCUMENT'

export async function listGrants(ctx: Ctx, documentId: string) {
  return ctx.db.resourcePolicy.findMany({
    where: { resourceType: DOCUMENT_RESOURCE, resourceId: documentId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      subjectType: true,
      subjectId: true,
      access: true,
      createdAt: true,
    },
  })
}

/**
 * Every document id this viewer holds a grant on, directly or through a role or
 * team they belong to.
 *
 * One query per subject kind rather than a join: the subject ids come from the
 * already-loaded context, and the result feeds a list filter.
 */
export async function grantedDocumentIds(
  ctx: Ctx,
  subjects: Array<{ type: 'USER' | 'ROLE' | 'TEAM'; id: string }>,
) {
  if (subjects.length === 0) return []

  const rows = await ctx.db.resourcePolicy.findMany({
    where: {
      resourceType: DOCUMENT_RESOURCE,
      OR: subjects.map((subject) => ({ subjectType: subject.type, subjectId: subject.id })),
    },
    select: { resourceId: true },
  })

  return [...new Set(rows.map((row) => row.resourceId))]
}

/** The strongest grant this viewer holds on one document. */
export async function grantsFor(
  ctx: Ctx,
  documentId: string,
  subjects: Array<{ type: 'USER' | 'ROLE' | 'TEAM'; id: string }>,
) {
  if (subjects.length === 0) return []

  return ctx.db.resourcePolicy.findMany({
    where: {
      resourceType: DOCUMENT_RESOURCE,
      resourceId: documentId,
      OR: subjects.map((subject) => ({ subjectType: subject.type, subjectId: subject.id })),
    },
    select: { access: true },
  })
}

export async function upsertGrant(
  ctx: Ctx,
  input: {
    subjectType: 'USER' | 'ROLE' | 'TEAM'
    subjectId: string
    documentId: string
    access: string
  },
) {
  return ctx.db.resourcePolicy.upsert({
    where: {
      organizationId_subjectType_subjectId_resourceType_resourceId: {
        organizationId: ctx.orgId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        resourceType: DOCUMENT_RESOURCE,
        resourceId: input.documentId,
      },
    },
    create: {
      organizationId: ctx.orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      resourceType: DOCUMENT_RESOURCE,
      resourceId: input.documentId,
      access: input.access as never,
      grantedById: ctx.userId,
    },
    update: { access: input.access as never },
    select: { id: true },
  })
}

export async function deleteGrant(ctx: Ctx, grantId: string, documentId: string) {
  const result = await ctx.db.resourcePolicy.deleteMany({
    where: { id: grantId, resourceType: DOCUMENT_RESOURCE, resourceId: documentId },
  })
  return result.count
}

/* ------------------------------- attachments ------------------------------ */

export async function listAttachments(ctx: Ctx, entityType: string, entityId: string) {
  return ctx.db.attachment.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      documentId: true,
      createdAt: true,
      document: {
        select: {
          id: true,
          name: true,
          mimeType: true,
          sizeBytes: true,
          visibility: true,
          scanStatus: true,
          uploadedById: true,
          deletedAt: true,
        },
      },
    },
  })
}

export async function createAttachment(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.attachment.create({
    data: { ...data, organizationId: ctx.orgId, attachedById: ctx.membershipId } as never,
    select: { id: true },
  })
}

export async function deleteAttachment(ctx: Ctx, id: string) {
  const result = await ctx.db.attachment.deleteMany({ where: { id } })
  return result.count
}

/* ------------------------------- aggregates ------------------------------- */

export async function storageUsed(ctx: Ctx) {
  const result = await ctx.db.document.aggregate({
    where: live,
    _sum: { sizeBytes: true },
    _count: { _all: true },
  })
  return { bytes: result._sum.sizeBytes ?? 0, count: result._count._all }
}

export async function memberTeamIds(ctx: Ctx) {
  const rows = await ctx.db.teamMember.findMany({
    where: { membershipId: ctx.membershipId },
    select: { teamId: true },
  })
  return rows.map((row) => row.teamId)
}

/**
 * Candidate subjects for a share.
 *
 * Read here rather than through the people module: sharing a document must not
 * require permission to browse the staff directory, and the only fields needed
 * are a name and an id.
 */
export async function listShareTargets(ctx: Ctx) {
  const [memberships, teams] = await Promise.all([
    ctx.db.membership.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { user: { name: 'asc' } },
      take: 500,
      select: { id: true, user: { select: { name: true } } },
    }),
    ctx.db.team.findMany({
      orderBy: { name: 'asc' },
      take: 200,
      select: { id: true, name: true },
    }),
  ])

  return {
    people: memberships.map((membership) => ({
      id: membership.id,
      name: membership.user.name,
    })),
    teams,
  }
}
