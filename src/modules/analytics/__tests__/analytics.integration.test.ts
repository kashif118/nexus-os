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
 * Analytics against a real database.
 *
 * What matters here, and is easy to get wrong:
 *
 * - a metric the caller may not see is not computed at all;
 * - money sums stay exact — no float drift between the ledger and the chart;
 * - another organization's rows never enter a figure;
 * - a period boundary includes what it should and excludes what it should not.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `analytics-${suffix}`
const OTHER_SLUG = `analytics-other-${suffix}`

const state = {
  orgId: '',
  otherOrgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

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
      name: 'Analytics Org',
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

/** An issued invoice with a payment against it. */
async function seedPayment(organizationId: string, amountMinor: bigint, receivedAt: Date) {
  const db = getSystemDb()
  const company = await db.company.create({
    data: { organizationId, name: `Client ${Math.random().toString(36).slice(2, 7)}` },
    select: { id: true },
  })

  const invoice = await db.invoice.create({
    data: {
      organizationId,
      number: `INV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      companyId: company.id,
      status: 'PAID',
      issueDate: receivedAt,
      dueDate: receivedAt,
      currency: 'USD',
      subtotalMinor: amountMinor,
      discountMinor: 0n,
      taxMinor: 0n,
      totalMinor: amountMinor,
      amountPaidMinor: amountMinor,
      balanceMinor: 0n,
    },
    select: { id: true },
  })

  await db.payment.create({
    data: {
      organizationId,
      invoiceId: invoice.id,
      companyId: company.id,
      amountMinor,
      currency: 'USD',
      method: 'BANK_TRANSFER',
      receivedAt,
    },
  })
}

describe.skipIf(!hasDatabase)('Analytics', () => {
  beforeAll(async () => {
    state.orgId = await seedOrg(SLUG, 'owner')
    state.otherOrgId = await seedOrg(OTHER_SLUG, 'otherOwner')

    await seedMember('employee', 'employee')

    // Inside a 30-day window: 1,234.56 + 765.44 = exactly 2,000.00.
    await seedPayment(state.orgId, 123_456n, daysAgo(5))
    await seedPayment(state.orgId, 76_544n, daysAgo(20))

    // Outside it, so a boundary error would show up as an inflated total.
    await seedPayment(state.orgId, 999_999n, daysAgo(200))

    // Another organization's money, which must never appear.
    await seedPayment(state.otherOrgId, 500_000n, daysAgo(3))
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('figures', () => {
    it('sums money exactly, in minor units', async () => {
      const ctx = await makeCtx('owner')
      const result = await service.getAnalytics(ctx, { period: '30d' })

      const revenue = result.metrics.find((metric) => metric.key === 'revenue.received')
      expect(revenue).toBeDefined()
      // Exact to the minor unit: no float has touched this on the way through.
      expect(revenue!.valueMinor).toBe(200_000n)
    })

    it('excludes what falls outside the period', async () => {
      const ctx = await makeCtx('owner')

      const thirty = await service.getAnalytics(ctx, { period: '30d' })
      const year = await service.getAnalytics(ctx, { period: '12m' })

      const inThirty = thirty.metrics.find((metric) => metric.key === 'revenue.received')!
      const inYear = year.metrics.find((metric) => metric.key === 'revenue.received')!

      expect(inThirty.valueMinor).toBe(200_000n)
      // The 200-day-old payment is in the year, not in the month.
      expect(inYear.valueMinor).toBe(1_199_999n)
    })

    it('never counts another organization’s rows', async () => {
      const ctx = await makeCtx('owner')
      const result = await service.getAnalytics(ctx, { period: '30d' })

      const revenue = result.metrics.find((metric) => metric.key === 'revenue.received')!
      // 500,000 from the other organization would have made this 700,000.
      expect(revenue.valueMinor).toBe(200_000n)
    })

    it('produces a series bucketed across the whole range', async () => {
      const ctx = await makeCtx('owner')
      const result = await service.getAnalytics(ctx, { period: '30d' })

      const series = result.series.find((entry) => entry.key === 'revenue.received')
      expect(series).toBeDefined()
      expect(series!.points).toHaveLength(30)

      // The series adds up to the same total as the headline figure.
      const summed = series!.points.reduce((sum, point) => sum + point.value, 0)
      expect(Math.round(summed * 100)).toBe(200_000)
    })

    it('compares against the preceding window of the same length', async () => {
      const ctx = await makeCtx('owner')
      const result = await service.getAnalytics(ctx, { period: '30d' })

      const revenue = result.metrics.find((metric) => metric.key === 'revenue.received')!
      // Nothing in the preceding 30 days, so there is no baseline to compare
      // against — and the honest answer is "no comparison", not "+infinity".
      expect(revenue.previousValue).toBe(0)
      expect(revenue.changePercent).toBeNull()
    })
  })

  describe('permissions', () => {
    it('does not compute a metric the caller may not see', async () => {
      const employee = await makeCtx('employee')
      const result = await service.getAnalytics(employee, { period: '30d' })

      const keys = result.metrics.map((metric) => metric.key)
      expect(keys).not.toContain('revenue.received')
      expect(keys).not.toContain('invoiced.total')

      // And the number is absent from the payload entirely, not merely hidden.
      expect(JSON.stringify(result)).not.toContain('200000')
    })

    it('still gives an Employee the metrics they are entitled to', async () => {
      const employee = await makeCtx('employee')
      const result = await service.getAnalytics(employee, { period: '30d' })

      expect(result.metrics.map((metric) => metric.key)).toContain('projects.active')
    })

    it('refuses analytics entirely to a role without any view permission', async () => {
      const db = getSystemDb()
      const user = await db.user.create({
        data: { email: `client-${suffix}@example.test`, name: 'client' },
        select: { id: true },
      })
      const membership = await db.membership.create({
        data: { organizationId: state.orgId, userId: user.id, status: 'ACTIVE' },
        select: { id: true },
      })
      const role = await db.role.findFirstOrThrow({
        where: { organizationId: null, key: 'client' },
        select: { id: true },
      })
      await db.membershipRole.create({
        data: { organizationId: state.orgId, membershipId: membership.id, roleId: role.id },
      })

      state.users.client = user.id
      state.memberships.client = membership.id

      const client = await makeCtx('client')
      await expect(service.getAnalytics(client, { period: '30d' })).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })
  })

  describe('the snapshot cache', () => {
    it('stores what the live computation produced', async () => {
      const ctx = await makeCtx('owner')
      await service.snapshotMetric(ctx, 'revenue.received', '30d')

      const snapshot = await getSystemDb().metricSnapshot.findFirst({
        where: { organizationId: state.orgId, metric: 'revenue.received' },
        select: { valueMinor: true, currency: true },
      })

      expect(snapshot?.valueMinor).toBe(200_000n)
      expect(snapshot?.currency).toBe('USD')
    })

    it('does not write a snapshot for a metric the caller may not see', async () => {
      const employee = await makeCtx('employee')
      await service.snapshotMetric(employee, 'invoiced.total', '30d')

      const snapshot = await getSystemDb().metricSnapshot.findFirst({
        where: { organizationId: state.orgId, metric: 'invoiced.total' },
        select: { id: true },
      })

      expect(snapshot).toBeNull()
    })

    it('overwrites rather than duplicating on a second run', async () => {
      const ctx = await makeCtx('owner')
      await service.snapshotMetric(ctx, 'revenue.received', '30d')
      await service.snapshotMetric(ctx, 'revenue.received', '30d')

      const count = await getSystemDb().metricSnapshot.count({
        where: { organizationId: state.orgId, metric: 'revenue.received' },
      })

      expect(count).toBe(1)
    })
  })
})
