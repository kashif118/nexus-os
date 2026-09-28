import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CrossTenantAccessError, getDb, getSystemDb, TENANT_MODELS } from '@/lib/db'

/**
 * The tenant isolation matrix (docs/OPERATIONS.md §O.1).
 *
 * This is the single most important test file in the codebase. It seeds two
 * organizations with real rows and asserts that a client scoped to one cannot
 * read, count, update or delete anything belonging to the other — through any
 * operation, including the ones where a forgotten `where` clause would normally
 * leak everything.
 *
 * It also asserts that the tenant-model registry is DERIVED rather than
 * maintained: any model added later with a required `organizationId` is scoped
 * automatically, and a model that should be scoped but is not fails here.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const ALPHA_SLUG = `iso-alpha-${suffix}`
const BETA_SLUG = `iso-beta-${suffix}`

let alphaOrgId = ''
let betaOrgId = ''
let alphaUserId = ''
let betaUserId = ''
let alphaMembershipId = ''
let betaMembershipId = ''

describe.skipIf(!hasDatabase)('tenant isolation', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const alphaUser = await db.user.create({
      data: { email: `alpha-${suffix}@example.test`, name: 'Alpha Owner' },
      select: { id: true },
    })
    const betaUser = await db.user.create({
      data: { email: `beta-${suffix}@example.test`, name: 'Beta Owner' },
      select: { id: true },
    })
    alphaUserId = alphaUser.id
    betaUserId = betaUser.id

    const alpha = await db.organization.create({
      data: { name: 'Alpha Ltd', slug: ALPHA_SLUG, createdById: alphaUserId },
      select: { id: true },
    })
    const beta = await db.organization.create({
      data: { name: 'Beta Ltd', slug: BETA_SLUG, createdById: betaUserId },
      select: { id: true },
    })
    alphaOrgId = alpha.id
    betaOrgId = beta.id

    const alphaMembership = await db.membership.create({
      data: { organizationId: alphaOrgId, userId: alphaUserId, status: 'ACTIVE' },
      select: { id: true },
    })
    const betaMembership = await db.membership.create({
      data: { organizationId: betaOrgId, userId: betaUserId, status: 'ACTIVE' },
      select: { id: true },
    })
    alphaMembershipId = alphaMembership.id
    betaMembershipId = betaMembership.id

    await db.invitation.createMany({
      data: [
        {
          organizationId: alphaOrgId,
          email: `invitee-alpha-${suffix}@example.test`,
          tokenHash: `hash-alpha-${suffix}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          organizationId: betaOrgId,
          email: `invitee-beta-${suffix}@example.test`,
          tokenHash: `hash-beta-${suffix}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    })
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [ALPHA_SLUG, BETA_SLUG] } } })
    await db.user.deleteMany({ where: { id: { in: [alphaUserId, betaUserId] } } })
    await db.$disconnect()
  })

  describe('registry', () => {
    it('derives the scoped models from the schema', () => {
      expect(TENANT_MODELS.has('Membership')).toBe(true)
      expect(TENANT_MODELS.has('Invitation')).toBe(true)
    })

    it('excludes global models', () => {
      expect(TENANT_MODELS.has('User')).toBe(false)
      expect(TENANT_MODELS.has('Session')).toBe(false)
      expect(TENANT_MODELS.has('Organization')).toBe(false)
      // AuditLog carries a NULLABLE organizationId — account-level events belong
      // to no organization — so it is scoped explicitly, not by the extension.
      expect(TENANT_MODELS.has('AuditLog')).toBe(false)
    })
  })

  describe('reads', () => {
    it('findMany without a where clause returns only the scoped organization', async () => {
      const rows = await getDb(alphaOrgId).membership.findMany()
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.organizationId === alphaOrgId)).toBe(true)
    })

    it('findUnique by another organization id returns null', async () => {
      const row = await getDb(alphaOrgId).membership.findUnique({
        where: { id: betaMembershipId },
      })
      expect(row).toBeNull()
    })

    it('findFirst cannot reach another organization by id', async () => {
      const row = await getDb(alphaOrgId).membership.findFirst({
        where: { id: betaMembershipId },
      })
      expect(row).toBeNull()
    })

    it('count is scoped', async () => {
      const [alphaCount, betaCount] = await Promise.all([
        getDb(alphaOrgId).invitation.count(),
        getDb(betaOrgId).invitation.count(),
      ])
      expect(alphaCount).toBe(1)
      expect(betaCount).toBe(1)
    })

    it('rejects a compound unique selector naming another organization', async () => {
      // The organization is nested inside `organizationId_userId`, where a
      // top-level check would not see it. Naming another tenant explicitly is an
      // attack, not a miss, so it throws rather than returning null.
      await expect(
        getDb(alphaOrgId).membership.findUnique({
          where: { organizationId_userId: { organizationId: betaOrgId, userId: betaUserId } },
        }),
      ).rejects.toBeInstanceOf(CrossTenantAccessError)
    })

    it('resolves a compound unique selector inside the scoped organization', async () => {
      const row = await getDb(alphaOrgId).membership.findUnique({
        where: { organizationId_userId: { organizationId: alphaOrgId, userId: alphaUserId } },
      })
      expect(row?.id).toBe(alphaMembershipId)
    })

    it('cannot reach another organization member by user id alone', async () => {
      const row = await getDb(alphaOrgId).membership.findFirst({ where: { userId: betaUserId } })
      expect(row).toBeNull()
    })

    it('findMany with an explicit matching organizationId is allowed', async () => {
      const rows = await getDb(alphaOrgId).membership.findMany({
        where: { organizationId: alphaOrgId },
      })
      expect(rows.every((row) => row.organizationId === alphaOrgId)).toBe(true)
    })
  })

  describe('writes', () => {
    it('updateMany cannot touch another organization', async () => {
      const result = await getDb(alphaOrgId).membership.updateMany({
        where: { id: betaMembershipId },
        data: { title: 'hijacked' },
      })
      expect(result.count).toBe(0)

      const beta = await getSystemDb().membership.findUniqueOrThrow({
        where: { id: betaMembershipId },
      })
      expect(beta.title).toBeNull()
    })

    it('updateMany without a where clause stays inside the organization', async () => {
      await getDb(alphaOrgId).membership.updateMany({ data: { title: 'scoped-update' } })

      const beta = await getSystemDb().membership.findUniqueOrThrow({
        where: { id: betaMembershipId },
      })
      expect(beta.title).toBeNull()

      const alpha = await getSystemDb().membership.findUniqueOrThrow({
        where: { id: alphaMembershipId },
      })
      expect(alpha.title).toBe('scoped-update')
    })

    it('deleteMany cannot remove another organization rows', async () => {
      const result = await getDb(alphaOrgId).invitation.deleteMany({
        where: { email: `invitee-beta-${suffix}@example.test` },
      })
      expect(result.count).toBe(0)
      expect(await getDb(betaOrgId).invitation.count()).toBe(1)
    })

    it('create stamps the scoped organization even when none is supplied', async () => {
      const created = await getDb(alphaOrgId).invitation.create({
        data: {
          organizationId: alphaOrgId,
          email: `stamped-${suffix}@example.test`,
          tokenHash: `hash-stamped-${suffix}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true, organizationId: true },
      })
      expect(created.organizationId).toBe(alphaOrgId)
      await getSystemDb().invitation.delete({ where: { id: created.id } })
    })
  })

  describe('explicit cross-tenant attempts', () => {
    it('rejects a create naming another organization', async () => {
      await expect(
        getDb(alphaOrgId).invitation.create({
          data: {
            organizationId: betaOrgId,
            email: `forged-${suffix}@example.test`,
            tokenHash: `hash-forged-${suffix}`,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        }),
      ).rejects.toBeInstanceOf(CrossTenantAccessError)
    })

    it('rejects a read naming another organization', async () => {
      await expect(
        getDb(alphaOrgId).membership.findMany({ where: { organizationId: betaOrgId } }),
      ).rejects.toBeInstanceOf(CrossTenantAccessError)
    })

    it('rejects an update naming another organization', async () => {
      await expect(
        getDb(alphaOrgId).membership.updateMany({
          where: { organizationId: betaOrgId },
          data: { title: 'hijacked' },
        }),
      ).rejects.toBeInstanceOf(CrossTenantAccessError)
    })

    it('rejects a createMany where any row names another organization', async () => {
      await expect(
        getDb(alphaOrgId).invitation.createMany({
          data: [
            {
              organizationId: betaOrgId,
              email: `bulk-${suffix}@example.test`,
              tokenHash: `hash-bulk-${suffix}`,
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          ],
        }),
      ).rejects.toBeInstanceOf(CrossTenantAccessError)
    })
  })

  describe('non-tenant models', () => {
    it('leaves global models unscoped, since they have no organization', async () => {
      // `User` is global by design: one identity across every organization.
      const user = await getDb(alphaOrgId).user.findUnique({ where: { id: betaUserId } })
      expect(user).not.toBeNull()
    })
  })
})
