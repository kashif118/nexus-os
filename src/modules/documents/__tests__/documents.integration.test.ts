import { rm } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  can,
  canAny,
  grantedFrom,
  require as requirePermission,
  requireAny,
  resolveScope,
} from '@/kernel/authz/can'
import type { Permission } from '@/kernel/authz/catalogue'
import { loadPermissions } from '@/kernel/authz/load'
import { isAppError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb } from '@/lib/db'

import * as service from '../service'

/**
 * Documents against a real database and real files on disk.
 *
 * The properties under test are the ones a leak depends on:
 *
 * - a private document is invisible to an organization-wide reader;
 * - a shared document becomes visible to exactly the person it was shared with;
 * - the listing and the single-document check agree (no document appears in a
 *   list that cannot be opened, and none is hidden that can);
 * - an upload that lies about its type is rejected on its bytes;
 * - another organization cannot read, download or share the document;
 * - a download is refused with NOT_FOUND, never FORBIDDEN.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `docs-${suffix}`
const OTHER_SLUG = `docs-other-${suffix}`
const meta = { ip: null, userAgent: 'vitest-documents' }
const STORAGE_DIR = `.storage-test-${suffix}`

const params = {
  page: 1,
  pageSize: 50,
  skip: 0,
  take: 50,
  sort: { field: 'createdAt' as const, direction: 'desc' as const },
  q: undefined,
}

const state = {
  orgId: '',
  otherOrgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

/** A real, valid PDF header followed by filler. */
const pdfBytes = (marker = 'x') =>
  new Uint8Array([
    0x25,
    0x50,
    0x44,
    0x46,
    ...new TextEncoder().encode(`-1.7 ${marker}${' '.repeat(64)}`),
  ])

async function makeCtx(key: string, orgId = state.orgId, slug = SLUG): Promise<Ctx> {
  const membershipId = state.memberships[key]!
  const isOwner = key === 'owner' || key === 'otherOwner'
  const { permissions, roles } = await loadPermissions({
    membershipId,
    organizationId: orgId,
    isOwner,
  })

  return Object.freeze({
    userId: state.users[key]!,
    sessionId: `s-${key}`,
    orgId,
    orgSlug: slug,
    membershipId,
    isOwner,
    user: { id: state.users[key]!, name: key, email: `${key}@example.test`, emailVerifiedAt: null },
    org: {
      id: orgId,
      slug,
      name: 'Docs Org',
      logoUrl: null,
      timezone: 'UTC',
      currency: 'USD',
    },
    roles,
    permissions,
    can: (p: Permission) => can(permissions, p),
    canAny: (p: readonly Permission[]) => canAny(permissions, p),
    require: (p: Permission) => requirePermission(permissions, p),
    requireAny: (p: readonly Permission[]) => requireAny(permissions, p),
    scope: (a: Permission, b: Permission) => resolveScope(permissions, a, b),
    granted: (c: readonly Permission[]) => grantedFrom(permissions, c),
    db: getDb(orgId),
  })
}

async function seedMember(key: string, roleKey: string, organizationId = state.orgId) {
  const db = getSystemDb()
  const user = await db.user.create({
    data: { email: `${key}-${suffix}@example.test`, name: key },
    select: { id: true },
  })
  const membership = await db.membership.create({
    data: { organizationId, userId: user.id, status: 'ACTIVE' },
    select: { id: true },
  })
  const role = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: roleKey },
    select: { id: true },
  })
  await db.membershipRole.create({
    data: { organizationId, membershipId: membership.id, roleId: role.id },
  })
  state.users[key] = user.id
  state.memberships[key] = membership.id
}

async function seedOrg(slug: string, ownerKey: string) {
  const db = getSystemDb()
  const owner = await db.user.create({
    data: { email: `${ownerKey}-${suffix}@example.test`, name: ownerKey },
    select: { id: true },
  })
  const org = await db.organization.create({
    data: { name: slug, slug, createdById: owner.id },
    select: { id: true },
  })
  const membership = await db.membership.create({
    data: { organizationId: org.id, userId: owner.id, status: 'ACTIVE' },
    select: { id: true },
  })
  state.users[ownerKey] = owner.id
  state.memberships[ownerKey] = membership.id
  return org.id
}

describe.skipIf(!hasDatabase)('Documents', () => {
  beforeAll(async () => {
    // Real files, in a directory this suite owns and removes afterwards.
    process.env.STORAGE_DRIVER = 'local'
    process.env.STORAGE_LOCAL_DIR = STORAGE_DIR

    state.orgId = await seedOrg(SLUG, 'owner')
    state.otherOrgId = await seedOrg(OTHER_SLUG, 'otherOwner')

    await seedMember('admin', 'admin')
    await seedMember('manager', 'manager')
    await seedMember('employee', 'employee')
    await seedMember('colleague', 'employee')
    await seedMember('client', 'client')
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
    await rm(STORAGE_DIR, { recursive: true, force: true })
  })

  describe('upload', () => {
    it('stores a valid file and returns it through the service', async () => {
      const ctx = await makeCtx('manager')

      const uploaded = await service.uploadDocument(
        ctx,
        {
          fileName: 'handbook.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('handbook'),
          visibility: 'ORGANIZATION',
        },
        meta,
      )

      const document = await service.getDocument(ctx, uploaded.id)
      expect(document.name).toBe('handbook.pdf')
      expect(document.mimeType).toBe('application/pdf')
      expect(document.version).toBe(1)
      expect(document.versions).toHaveLength(1)
    })

    it('never exposes the storage key to a caller', async () => {
      const ctx = await makeCtx('manager')
      const uploaded = await service.uploadDocument(
        ctx,
        { fileName: 'key-check.pdf', declaredType: 'application/pdf', body: pdfBytes('k') },
        meta,
      )

      const document = await service.getDocument(ctx, uploaded.id)
      expect(document).not.toHaveProperty('storageKey')
      expect(JSON.stringify(document)).not.toContain('org/')
    })

    it('rejects a file whose bytes contradict its declared type', async () => {
      const ctx = await makeCtx('manager')

      await expect(
        service.uploadDocument(
          ctx,
          {
            fileName: 'payload.pdf',
            declaredType: 'application/pdf',
            body: new TextEncoder().encode('<html><script>alert(1)</script></html>'),
          },
          meta,
        ),
      ).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      )
    })

    it('refuses an upload from a role without the permission', async () => {
      // A Client is an external party: they may read what is shared with them
      // and nothing else.
      const client = await makeCtx('client')
      expect(client.can('document.upload')).toBe(false)

      await expect(
        service.uploadDocument(
          client,
          { fileName: 'x.pdf', declaredType: 'application/pdf', body: pdfBytes() },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('refuses folder management to a role without the permission', async () => {
      const employee = await makeCtx('employee')

      await expect(service.createFolder(employee, { name: 'Mine' }, meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })
  })

  describe('visibility', () => {
    it('hides a private document from an administrator', async () => {
      const employee = await makeCtx('employee')
      const admin = await makeCtx('admin')

      const uploaded = await service.uploadDocument(
        employee,
        {
          fileName: 'personal.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('personal'),
          visibility: 'PRIVATE',
        },
        meta,
      )

      // The uploader sees it.
      await expect(service.getDocument(employee, uploaded.id)).resolves.toMatchObject({
        visibility: 'PRIVATE',
      })

      // The administrator does not — not in the listing, not by id, not by
      // download. PRIVATE means private.
      await expect(service.getDocument(admin, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )

      const adminList = await service.listDocuments(admin, params)
      expect(adminList.items.map((item) => item.id)).not.toContain(uploaded.id)

      await expect(service.downloadDocument(admin, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('hides a restricted document from a colleague but not from an administrator', async () => {
      const employee = await makeCtx('employee')
      const colleague = await makeCtx('colleague')
      const admin = await makeCtx('admin')

      const uploaded = await service.uploadDocument(
        employee,
        {
          fileName: 'restricted.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('restricted'),
          visibility: 'RESTRICTED',
        },
        meta,
      )

      await expect(service.getDocument(colleague, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
      await expect(service.getDocument(admin, uploaded.id)).resolves.toMatchObject({
        accessReason: 'ORGANIZATION_READER',
      })
    })

    it('makes a shared document visible to exactly the person it was shared with', async () => {
      const employee = await makeCtx('employee')
      const colleague = await makeCtx('colleague')
      const manager = await makeCtx('manager')

      const uploaded = await service.uploadDocument(
        employee,
        {
          fileName: 'shared.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('shared'),
          visibility: 'PRIVATE',
        },
        meta,
      )

      await service.shareDocument(
        employee,
        {
          documentId: uploaded.id,
          subjectType: 'USER',
          subjectId: state.memberships.colleague!,
          access: 'VIEW',
        },
        meta,
      )

      const forColleague = await service.getDocument(colleague, uploaded.id)
      expect(forColleague.accessReason).toBe('EXPLICIT_GRANT')

      const colleagueList = await service.listDocuments(colleague, params)
      expect(colleagueList.items.map((item) => item.id)).toContain(uploaded.id)

      // The manager was not named, so nothing changed for them.
      await expect(service.getDocument(manager, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('revoking a share removes access again', async () => {
      const employee = await makeCtx('employee')
      const colleague = await makeCtx('colleague')

      const uploaded = await service.uploadDocument(
        employee,
        {
          fileName: 'temporary.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('temp'),
          visibility: 'PRIVATE',
        },
        meta,
      )

      await service.shareDocument(
        employee,
        {
          documentId: uploaded.id,
          subjectType: 'USER',
          subjectId: state.memberships.colleague!,
          access: 'VIEW',
        },
        meta,
      )

      const grants = await service.listGrants(employee, uploaded.id)
      expect(grants).toHaveLength(1)

      await service.revokeGrant(employee, { documentId: uploaded.id, grantId: grants[0]!.id }, meta)

      await expect(service.getDocument(colleague, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('refuses to let a viewer widen visibility they cannot share', async () => {
      const employee = await makeCtx('employee')
      const colleague = await makeCtx('colleague')

      const uploaded = await service.uploadDocument(
        employee,
        {
          fileName: 'narrow.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('narrow'),
          visibility: 'PRIVATE',
        },
        meta,
      )

      await service.shareDocument(
        employee,
        {
          documentId: uploaded.id,
          subjectType: 'USER',
          subjectId: state.memberships.colleague!,
          access: 'EDIT',
        },
        meta,
      )

      // An EDIT grant may rename, but must not publish it to the organization.
      await expect(
        service.updateDocument(
          colleague,
          uploaded.id,
          { name: 'narrow.pdf', visibility: 'ORGANIZATION' },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })
  })

  describe('download', () => {
    it('returns exactly the bytes that were stored', async () => {
      const ctx = await makeCtx('manager')
      const body = pdfBytes('round-trip')

      const uploaded = await service.uploadDocument(
        ctx,
        { fileName: 'roundtrip.pdf', declaredType: 'application/pdf', body },
        meta,
      )

      const file = await service.downloadDocument(ctx, uploaded.id)
      expect(Array.from(file.body)).toEqual(Array.from(body))
      expect(file.mimeType).toBe('application/pdf')
      expect(file.fileName).toBe('roundtrip.pdf')
    })

    it('serves an older version when asked, and the newest by default', async () => {
      const ctx = await makeCtx('manager')
      const first = pdfBytes('v1')
      const second = pdfBytes('v2-longer-content')

      const uploaded = await service.uploadDocument(
        ctx,
        { fileName: 'versioned.pdf', declaredType: 'application/pdf', body: first },
        meta,
      )

      const result = await service.addVersion(
        ctx,
        {
          documentId: uploaded.id,
          fileName: 'versioned.pdf',
          declaredType: 'application/pdf',
          body: second,
        },
        meta,
      )
      expect(result.version).toBe(2)

      const latest = await service.downloadDocument(ctx, uploaded.id)
      expect(Array.from(latest.body)).toEqual(Array.from(second))

      const document = await service.getDocument(ctx, uploaded.id)
      const firstVersion = document.versions.find((version) => version.version === 1)!
      const older = await service.downloadDocument(ctx, uploaded.id, {
        versionId: firstVersion.id,
      })
      expect(Array.from(older.body)).toEqual(Array.from(first))
    })

    it('refuses a new version of a different file type', async () => {
      const ctx = await makeCtx('manager')
      const uploaded = await service.uploadDocument(
        ctx,
        { fileName: 'typed.pdf', declaredType: 'application/pdf', body: pdfBytes('typed') },
        meta,
      )

      await expect(
        service.addVersion(
          ctx,
          {
            documentId: uploaded.id,
            fileName: 'typed.png',
            declaredType: 'image/png',
            body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
          },
          meta,
        ),
      ).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      )
    })
  })

  describe('tenant isolation', () => {
    it('cannot read, download or share another organization’s document', async () => {
      const ctx = await makeCtx('manager')
      const stranger = await makeCtx('otherOwner', state.otherOrgId, OTHER_SLUG)

      const uploaded = await service.uploadDocument(
        ctx,
        {
          fileName: 'ours.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('ours'),
          visibility: 'ORGANIZATION',
        },
        meta,
      )

      await expect(service.getDocument(stranger, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
      await expect(service.downloadDocument(stranger, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
      await expect(
        service.shareDocument(
          stranger,
          {
            documentId: uploaded.id,
            subjectType: 'USER',
            subjectId: state.memberships.otherOwner!,
            access: 'VIEW',
          },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'NOT_FOUND')
    })

    it('refuses to share with a subject from another organization', async () => {
      const ctx = await makeCtx('manager')

      const uploaded = await service.uploadDocument(
        ctx,
        { fileName: 'subject-check.pdf', declaredType: 'application/pdf', body: pdfBytes('s') },
        meta,
      )

      await expect(
        service.shareDocument(
          ctx,
          {
            documentId: uploaded.id,
            subjectType: 'USER',
            subjectId: state.memberships.otherOwner!,
            access: 'VIEW',
          },
          meta,
        ),
      ).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      )
    })
  })

  describe('folders', () => {
    it('derives the path from the parent and refuses to delete a folder with contents', async () => {
      const ctx = await makeCtx('manager')

      const parent = await service.createFolder(ctx, { name: 'Contracts' }, meta)
      const child = await service.createFolder(ctx, { name: '2026', parentId: parent.id }, meta)

      const folders = await service.listFolders(ctx)
      expect(folders.find((folder) => folder.id === child.id)?.path).toBe('/Contracts/2026')

      await service.uploadDocument(
        ctx,
        {
          fileName: 'filed.pdf',
          declaredType: 'application/pdf',
          body: pdfBytes('filed'),
          folderId: child.id,
        },
        meta,
      )

      await expect(service.deleteFolder(ctx, child.id, meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
      await expect(service.deleteFolder(ctx, parent.id, meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
    })

    it('refuses a duplicate name under the same parent', async () => {
      const ctx = await makeCtx('manager')
      await service.createFolder(ctx, { name: 'Policies' }, meta)

      await expect(service.createFolder(ctx, { name: 'Policies' }, meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
    })
  })

  describe('deletion', () => {
    it('removes a document from listings without destroying the stored bytes', async () => {
      const ctx = await makeCtx('admin')

      const uploaded = await service.uploadDocument(
        ctx,
        { fileName: 'doomed.pdf', declaredType: 'application/pdf', body: pdfBytes('doomed') },
        meta,
      )

      await service.deleteDocument(ctx, uploaded.id, meta)

      await expect(service.getDocument(ctx, uploaded.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )

      const list = await service.listDocuments(ctx, params)
      expect(list.items.map((item) => item.id)).not.toContain(uploaded.id)

      // Soft delete is reversible by design, so the row and the object survive.
      const row = await getSystemDb().document.findUnique({
        where: { id: uploaded.id },
        select: { deletedAt: true },
      })
      expect(row?.deletedAt).not.toBeNull()
    })
  })
})
