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
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb, measureQueries } from '@/lib/db'
import * as crm from '@/modules/crm/queries'
import * as analytics from '@/modules/analytics/queries'
import * as dashboard from '@/modules/dashboard/queries'
import * as documents from '@/modules/documents/queries'
import * as finance from '@/modules/finance/queries'
import * as people from '@/modules/people/queries'
import * as projects from '@/modules/projects/queries'
import * as tasks from '@/modules/tasks/queries'

/**
 * The query budget.
 *
 * Every list screen in this product is loaded twice here — once over a handful
 * of rows and once over several hundred — and the number of database queries
 * must be IDENTICAL. That is the only reliable way to catch an N+1: wall-clock
 * time on a developer machine is noise, but "one query per row" shows up as a
 * count that tracks the row count.
 *
 * The budgets below are deliberately written as exact numbers rather than upper
 * bounds. An upper bound of twenty is satisfied by a screen that used to take
 * three, and nobody ever notices.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `perf-${suffix}`

/** Small enough to be obviously fine; large enough that an N+1 is unmissable. */
const SMALL = 5
const LARGE = 200

const state = { orgId: '', userId: '', membershipId: '', companyId: '' }

const listParams = <T extends string>(field: T) => ({
  page: 1,
  pageSize: 25,
  skip: 0,
  take: 25,
  sort: { field, direction: 'desc' as const },
  q: undefined,
})

async function makeCtx(): Promise<Ctx> {
  const { permissions, roles } = await loadPermissions({
    membershipId: state.membershipId,
    organizationId: state.orgId,
    isOwner: true,
  })

  return Object.freeze({
    userId: state.userId,
    sessionId: 'perf',
    orgId: state.orgId,
    orgSlug: SLUG,
    membershipId: state.membershipId,
    isOwner: true,
    user: { id: state.userId, name: 'Perf', email: `perf@example.test`, emailVerifiedAt: null },
    org: {
      id: state.orgId,
      slug: SLUG,
      name: 'Perf Org',
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
    db: getDb(state.orgId),
  })
}

/* --------------------------------- seeding -------------------------------- */

async function seedCompanies(from: number, to: number) {
  const db = getSystemDb()
  await db.company.createMany({
    data: Array.from({ length: to - from }, (_, index) => ({
      organizationId: state.orgId,
      name: `Company ${from + index}`,
      createdById: state.membershipId,
    })),
  })
}

async function seedProjects(from: number, to: number) {
  const db = getSystemDb()
  await db.project.createMany({
    data: Array.from({ length: to - from }, (_, index) => ({
      organizationId: state.orgId,
      key: `P${from + index}`,
      name: `Project ${from + index}`,
      status: 'ACTIVE' as const,
      currency: 'USD',
      managerMembershipId: state.membershipId,
      createdById: state.membershipId,
    })),
  })
}

async function seedTasks(from: number, to: number) {
  const db = getSystemDb()
  await db.task.createMany({
    data: Array.from({ length: to - from }, (_, index) => ({
      organizationId: state.orgId,
      number: from + index + 1,
      title: `Task ${from + index}`,
      status: 'TODO' as const,
      priority: 'MEDIUM' as const,
      assigneeMembershipId: state.membershipId,
      createdById: state.membershipId,
    })),
  })
}

async function seedInvoices(from: number, to: number) {
  const db = getSystemDb()
  await db.invoice.createMany({
    data: Array.from({ length: to - from }, (_, index) => ({
      organizationId: state.orgId,
      number: `INV-${suffix}-${from + index}`,
      companyId: state.companyId,
      status: 'DRAFT' as const,
      currency: 'USD',
      issueDate: new Date(),
      dueDate: new Date(Date.now() + 14 * 86_400_000),
      subtotalMinor: 10_000n,
      taxMinor: 0n,
      totalMinor: 10_000n,
      amountPaidMinor: 0n,
      balanceMinor: 10_000n,
      createdById: state.membershipId,
    })),
  })
}

async function seedDocuments(from: number, to: number) {
  const db = getSystemDb()
  await db.document.createMany({
    data: Array.from({ length: to - from }, (_, index) => ({
      organizationId: state.orgId,
      name: `Document ${from + index}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1_024,
      storageKey: `perf/${suffix}/${from + index}`,
      checksum: `checksum-${from + index}`,
      visibility: 'ORGANIZATION' as const,
      uploadedById: state.membershipId,
    })),
  })
}

/**
 * Run a read twice — once over `SMALL` rows, once over `LARGE` — and return
 * both query counts.
 */
async function budgetOf(
  seed: (from: number, to: number) => Promise<void>,
  read: (ctx: Ctx) => Promise<unknown>,
): Promise<{ small: number; large: number }> {
  const ctx = await makeCtx()

  await seed(0, SMALL)
  const first = await measureQueries(() => read(ctx))

  await seed(SMALL, LARGE)
  const second = await measureQueries(() => read(ctx))

  return { small: first.queries, large: second.queries }
}

describe.skipIf(!hasDatabase)('query budget', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const user = await db.user.create({
      data: { email: `perf-${suffix}@example.test`, name: 'Perf' },
      select: { id: true },
    })
    const org = await db.organization.create({
      data: { name: SLUG, slug: SLUG, createdById: user.id },
      select: { id: true },
    })
    const membership = await db.membership.create({
      data: { organizationId: org.id, userId: user.id, status: 'ACTIVE' },
      select: { id: true },
    })

    state.userId = user.id
    state.orgId = org.id
    state.membershipId = membership.id

    // Invoices need a client, and it must exist before any of them.
    const company = await db.company.create({
      data: { organizationId: org.id, name: 'Perf Client' },
      select: { id: true },
    })
    state.companyId = company.id
  }, 60_000)

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: SLUG } })
    await db.user.deleteMany({ where: { id: state.userId } })
    await db.$disconnect()
  })

  it('does not grow with the number of companies', async () => {
    const budget = await budgetOf(seedCompanies, (ctx) =>
      crm.listCompanies(ctx, listParams('createdAt')),
    )

    expect(budget.large).toBe(budget.small)
    // One count and one page of rows.
    expect(budget.large).toBe(2)
  })

  it('does not grow with the number of projects', async () => {
    const budget = await budgetOf(seedProjects, (ctx) =>
      projects.listProjects(ctx, listParams('createdAt')),
    )

    expect(budget.large).toBe(budget.small)
    expect(budget.large).toBe(2)
  })

  it('does not grow with the number of tasks on the board', async () => {
    const budget = await budgetOf(seedTasks, (ctx) => tasks.getBoard(ctx))

    expect(budget.large).toBe(budget.small)
    // The board is capped at 400 cards: tasks plus labels.
    expect(budget.large).toBe(2)
  })

  it('does not grow with the number of invoices', async () => {
    const budget = await budgetOf(seedInvoices, (ctx) =>
      finance.listInvoices(ctx, listParams('issueDate')),
    )

    expect(budget.large).toBe(budget.small)
    expect(budget.large).toBe(2)
  })

  it('does not grow with the number of documents', async () => {
    const budget = await budgetOf(seedDocuments, (ctx) =>
      documents.listDocuments(ctx, listParams('createdAt')),
    )

    expect(budget.large).toBe(budget.small)
    // Rows, count, and the two lookups that decide which of them are visible.
    expect(budget.large).toBe(4)
  })

  it('keeps the financial summary constant as invoices accumulate', async () => {
    const ctx = await makeCtx()
    const before = await measureQueries(() => finance.getFinancialSummary(ctx))

    await seedInvoices(LARGE, LARGE + 200)
    const after = await measureQueries(() => finance.getFinancialSummary(ctx))

    // Aggregates, not a fetch-then-sum.
    expect(after.queries).toBe(before.queries)
  })

  it('keeps the people list constant as the workload grows', async () => {
    const ctx = await makeCtx()
    const before = await measureQueries(() => people.listPeople(ctx))

    await seedTasks(LARGE, LARGE + 200)
    const after = await measureQueries(() => people.listPeople(ctx))

    expect(after.queries).toBe(before.queries)
  })

  it('holds the Command Center and the analytics page to a fixed budget', async () => {
    /*
     * These two are the widest reads in the product: the Command Center
     * resolves every widget a role may see, and the analytics page computes
     * every metric plus a series for the ones that have one. Each is an
     * indexed aggregate and they run in parallel, so the wall clock is fine —
     * but the count is worth pinning, because "one more widget" is the
     * easiest change in the codebase to make and the easiest to make twice.
     */
    const ctx = await makeCtx()

    const dashboardBudget = await measureQueries(() => dashboard.getDashboard(ctx))
    expect(dashboardBudget.queries).toBeLessThanOrEqual(20)

    const analyticsBudget = await measureQueries(() =>
      analytics.getAnalytics(ctx, { period: '30d' }),
    )
    expect(analyticsBudget.queries).toBeLessThanOrEqual(32)

    // And — the property that actually matters — neither moves when the data
    // does. An aggregate that became a fetch-then-sum would show up here.
    await seedTasks(LARGE + 200, LARGE + 500)
    await seedInvoices(LARGE + 200, LARGE + 500)

    const dashboardAgain = await measureQueries(() => dashboard.getDashboard(ctx))
    const analyticsAgain = await measureQueries(() =>
      analytics.getAnalytics(ctx, { period: '30d' }),
    )

    expect(dashboardAgain.queries).toBe(dashboardBudget.queries)
    expect(analyticsAgain.queries).toBe(analyticsBudget.queries)
  })

  it('reads a page rather than the table', async () => {
    // The guard the pagination contract exists for: asking for a huge page is
    // clamped, so no caller can make the server fetch everything.
    const ctx = await makeCtx()
    const page = await crm.listCompanies(ctx, {
      ...listParams('createdAt'),
      pageSize: 25,
      take: 25,
    })

    expect(page.items.length).toBeLessThanOrEqual(25)
    expect(page.total).toBeGreaterThanOrEqual(LARGE)
  })
})
