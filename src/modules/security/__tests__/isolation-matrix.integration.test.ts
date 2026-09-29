import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CrossTenantAccessError, getDb, getSystemDb, TENANT_MODELS } from '@/lib/db'

/**
 * The isolation matrix.
 *
 * Every other test in this repository checks one module's behaviour. This one
 * checks the property the whole product rests on, mechanically, for EVERY model
 * in the tenant registry: an org-scoped client cannot read, count, update or
 * delete another organization's rows, and cannot be made to by supplying an
 * organization id.
 *
 * It is generated from `TENANT_MODELS` rather than written out, so a model
 * added in a future phase is covered the day it is registered — and the
 * registry itself is already kept honest by the schema-parsing test in
 * `src/lib/__tests__/tenant-registry.test.ts`. Together they mean a new tenant
 * table cannot ship unscoped and untested.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG_A = `iso-a-${suffix}`
const SLUG_B = `iso-b-${suffix}`

const state = { orgA: '', orgB: '', userA: '', userB: '' }

/** Prisma model name → the accessor on the client. */
const accessorFor = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1)

describe.skipIf(!hasDatabase)('tenant isolation matrix', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const userA = await db.user.create({
      data: { email: `iso-a-${suffix}@example.test`, name: 'A' },
      select: { id: true },
    })
    const userB = await db.user.create({
      data: { email: `iso-b-${suffix}@example.test`, name: 'B' },
      select: { id: true },
    })

    const orgA = await db.organization.create({
      data: { name: SLUG_A, slug: SLUG_A, createdById: userA.id },
      select: { id: true },
    })
    const orgB = await db.organization.create({
      data: { name: SLUG_B, slug: SLUG_B, createdById: userB.id },
      select: { id: true },
    })

    state.orgA = orgA.id
    state.orgB = orgB.id
    state.userA = userA.id
    state.userB = userB.id

    // One row belonging to organization B, in a model every scoped read covers.
    await db.membership.create({
      data: { organizationId: orgB.id, userId: userB.id, status: 'ACTIVE' },
    })
    await db.company.create({ data: { organizationId: orgB.id, name: `Secret ${suffix}` } })
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } })
    await db.user.deleteMany({ where: { id: { in: [state.userA, state.userB] } } })
    await db.$disconnect()
  })

  describe('reads', () => {
    it.each([...TENANT_MODELS])(
      '%s: a scoped client never returns another organization’s rows',
      async (model) => {
        const scoped = getDb(state.orgA) as unknown as Record<
          string,
          { findMany(args: unknown): Promise<Array<{ organizationId?: string }>> }
        >

        const accessor = scoped[accessorFor(model)]
        expect(accessor, `no client accessor for ${model}`).toBeDefined()

        const rows = await accessor!.findMany({ take: 200 })

        for (const row of rows) {
          // Not "no rows" — some models legitimately have none — but "no row
          // from anywhere else", which is the property that matters.
          expect(row.organizationId, `${model} leaked a row`).toBe(state.orgA)
        }
      },
    )

    it.each([...TENANT_MODELS])(
      '%s: a supplied organization id is refused, not silently rewritten',
      async (model) => {
        const scoped = getDb(state.orgA) as unknown as Record<
          string,
          { findMany(args: unknown): Promise<unknown> }
        >

        // The classic attack: pass the other organization's id in the filter.
        // The extension REFUSES rather than quietly overriding — a silent
        // override would hide the bug that let client input reach it.
        await expect(
          scoped[accessorFor(model)]!.findMany({
            where: { organizationId: state.orgB },
            take: 200,
          }),
        ).rejects.toBeInstanceOf(CrossTenantAccessError)
      },
    )

    it.each([...TENANT_MODELS])(
      '%s: the caller’s OWN organization id is accepted, so explicit queries stay readable',
      async (model) => {
        const scoped = getDb(state.orgA) as unknown as Record<
          string,
          { findMany(args: unknown): Promise<Array<{ organizationId?: string }>> }
        >

        const rows = await scoped[accessorFor(model)]!.findMany({
          where: { organizationId: state.orgA },
          take: 200,
        })

        for (const row of rows) {
          expect(row.organizationId).toBe(state.orgA)
        }
      },
    )

    it.each([...TENANT_MODELS])('%s: counts are scoped too', async (model) => {
      const scopedA = getDb(state.orgA) as unknown as Record<
        string,
        { count(args: unknown): Promise<number> }
      >
      const system = getSystemDb() as unknown as Record<
        string,
        { count(args: unknown): Promise<number> }
      >

      const scopedCount = await scopedA[accessorFor(model)]!.count({})
      const orgACount = await system[accessorFor(model)]!.count({
        where: { organizationId: state.orgA },
      })

      // A count that ignored the scope would include organization B's rows.
      expect(scopedCount).toBe(orgACount)
    })
  })

  describe('writes', () => {
    it('cannot update another organization’s row', async () => {
      const scoped = getDb(state.orgA)

      const result = await scoped.company.updateMany({
        where: { name: `Secret ${suffix}` },
        data: { name: 'Renamed by the wrong tenant' },
      })

      expect(result.count).toBe(0)

      const untouched = await getSystemDb().company.findFirst({
        where: { organizationId: state.orgB },
        select: { name: true },
      })
      expect(untouched?.name).toBe(`Secret ${suffix}`)
    })

    it('cannot delete another organization’s row', async () => {
      const scoped = getDb(state.orgA)

      const result = await scoped.company.deleteMany({ where: { name: `Secret ${suffix}` } })
      expect(result.count).toBe(0)

      const survivor = await getSystemDb().company.count({
        where: { organizationId: state.orgB },
      })
      expect(survivor).toBe(1)
    })

    it('refuses a create that names another organization', async () => {
      const scoped = getDb(state.orgA)

      await expect(
        scoped.company.create({
          data: { organizationId: state.orgB, name: `Stamped ${suffix}` } as never,
          select: { id: true },
        }),
      ).rejects.toBeInstanceOf(CrossTenantAccessError)

      const leaked = await getSystemDb().company.count({
        where: { name: `Stamped ${suffix}` },
      })
      expect(leaked).toBe(0)
    })

    it('stamps the scope on a create that names no organization', async () => {
      const scoped = getDb(state.orgA)

      const created = await scoped.company.create({
        data: { name: `Unstamped ${suffix}` } as never,
        select: { organizationId: true },
      })

      expect(created.organizationId).toBe(state.orgA)
    })
  })

  describe('single-record lookups', () => {
    it('refuses to read another organization’s row by id', async () => {
      const theirs = await getSystemDb().company.findFirstOrThrow({
        where: { organizationId: state.orgB, name: `Secret ${suffix}` },
        select: { id: true },
      })

      const scoped = getDb(state.orgA)

      // findFirst is rewritten to include the scope, so a known id from another
      // tenant simply does not resolve.
      const found = await scoped.company.findFirst({ where: { id: theirs.id } })
      expect(found).toBeNull()
    })

    it('rewrites findUnique so a global id cannot bypass the scope', async () => {
      const theirs = await getSystemDb().company.findFirstOrThrow({
        where: { organizationId: state.orgB },
        select: { id: true },
      })

      const scoped = getDb(state.orgA)
      const found = await scoped.company.findUnique({ where: { id: theirs.id } })

      expect(found).toBeNull()
    })
  })

  describe('the registry itself', () => {
    it('covers every model the matrix exercises', () => {
      // Guards against the matrix quietly testing nothing if the registry were
      // emptied: a passing suite over zero models would look identical.
      expect(TENANT_MODELS.size).toBeGreaterThan(40)
    })

    it('exports the error the extension throws on a cross-tenant attempt', () => {
      expect(CrossTenantAccessError).toBeTypeOf('function')
    })
  })
})
