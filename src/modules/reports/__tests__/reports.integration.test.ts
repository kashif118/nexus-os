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

import { toCsv } from '../export'
import * as service from '../service'

/**
 * Reports against a real database.
 *
 * The property that matters: a report is generated with the VIEWER's context,
 * so two people opening the same saved report each see only what they are
 * entitled to. A report is not a way around the permission model.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `reports-${suffix}`
const OTHER_SLUG = `reports-other-${suffix}`
const meta = { ip: null, userAgent: 'vitest-reports' }

const SECRET_CLIENT = `ZZZ-OTHER-CLIENT-${suffix}`

const state = {
  orgId: '',
  otherOrgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

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
    org: { id: orgId, slug, name: 'Report Org', logoUrl: null, timezone: 'UTC', currency: 'USD' },
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

async function seedOverdueInvoice(organizationId: string, clientName: string, minor: bigint) {
  const db = getSystemDb()
  const company = await db.company.create({
    data: { organizationId, name: clientName },
    select: { id: true },
  })

  await db.invoice.create({
    data: {
      organizationId,
      number: `INV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      companyId: company.id,
      status: 'OVERDUE',
      issueDate: new Date(Date.now() - 120 * 86_400_000),
      dueDate: new Date(Date.now() - 95 * 86_400_000),
      currency: 'USD',
      subtotalMinor: minor,
      discountMinor: 0n,
      taxMinor: 0n,
      totalMinor: minor,
      amountPaidMinor: 0n,
      balanceMinor: minor,
    },
  })
}

describe.skipIf(!hasDatabase)('Reports', () => {
  beforeAll(async () => {
    state.orgId = await seedOrg(SLUG, 'owner')
    state.otherOrgId = await seedOrg(OTHER_SLUG, 'otherOwner')

    await seedMember('employee', 'employee')
    // An HR Manager can generate and view reports but cannot see invoices —
    // exactly the case that proves a report is not a way around permissions.
    await seedMember('hr', 'hr_manager')

    await seedOverdueInvoice(state.orgId, 'Debtor Ltd', 250_000n)
    await seedOverdueInvoice(state.otherOrgId, SECRET_CLIENT, 999_999n)
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('templates', () => {
    it('offers only the templates the caller has the data permissions for', async () => {
      const owner = await makeCtx('owner')
      const employee = await makeCtx('employee')

      const hr = await makeCtx('hr')

      const ownerKeys = service.availableTemplates(owner).map((template) => template.key)
      const employeeKeys = service.availableTemplates(employee).map((template) => template.key)
      const hrKeys = service.availableTemplates(hr).map((template) => template.key)

      expect(ownerKeys).toContain('receivables-ageing')
      // An Employee has no report permission at all, so nothing is offered.
      expect(employeeKeys).toEqual([])
      // HR can report, but not on money.
      expect(hrKeys).toContain('team-workload')
      expect(hrKeys).not.toContain('receivables-ageing')
    })
  })

  describe('generating', () => {
    it('computes from real rows and never from another organization', async () => {
      const owner = await makeCtx('owner')
      const output = await service.preview(owner, 'receivables-ageing', {})

      const serialised = JSON.stringify(output)
      expect(serialised).toContain('Debtor Ltd')
      expect(serialised).toContain('2,500.00')
      expect(serialised).not.toContain(SECRET_CLIENT)
    })

    it('refuses a template the caller may not run', async () => {
      // The HR Manager may generate reports, and may not see invoices. The
      // refusal is NOT_FOUND rather than FORBIDDEN: the existence of a
      // receivables report is itself information about the finances.
      const hr = await makeCtx('hr')
      expect(hr.can('report.generate')).toBe(true)
      expect(hr.can('finance.invoice.read')).toBe(false)

      await expect(service.preview(hr, 'receivables-ageing', {})).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('exports the same figures it displays', async () => {
      const owner = await makeCtx('owner')
      const output = await service.preview(owner, 'receivables-ageing', {})
      const csv = toCsv(output)

      expect(csv).toContain('Debtor Ltd')
      expect(csv).toContain('Receivables ageing')
      expect(csv).not.toContain(SECRET_CLIENT)
    })
  })

  describe('saving', () => {
    it('stores parameters, not output', async () => {
      const owner = await makeCtx('owner')

      const saved = await service.createReport(
        owner,
        {
          template: 'executive-summary',
          name: `Monthly summary ${suffix}`,
          period: '30d',
          schedule: null,
        },
        meta,
      )

      const row = await getSystemDb().report.findUniqueOrThrow({
        where: { id: saved.id },
        select: { parameters: true },
      })

      expect(row.parameters).toEqual({ period: '30d' })

      // Opening it re-runs, so the result is current rather than a snapshot.
      const output = await service.generate(owner, saved.id)
      expect(output.title).toBe('Executive summary')
      expect(output.generatedAt.getTime()).toBeGreaterThan(Date.now() - 10_000)
    })

    it('refuses a duplicate name', async () => {
      const owner = await makeCtx('owner')
      const name = `Duplicate ${suffix}`

      await service.createReport(owner, { template: 'project-status', name, schedule: null }, meta)

      await expect(
        service.createReport(owner, { template: 'project-status', name, schedule: null }, meta),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'CONFLICT')
    })

    it('refuses to save a report the caller cannot run', async () => {
      const employee = await makeCtx('employee')

      await expect(
        service.createReport(
          employee,
          { template: 'receivables-ageing', name: `Nope ${suffix}`, schedule: null },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('does not list a report whose template the viewer may not run', async () => {
      const owner = await makeCtx('owner')
      await service.createReport(
        owner,
        { template: 'receivables-ageing', name: `Ageing ${suffix}`, schedule: null },
        meta,
      )

      const hr = await makeCtx('hr')
      const visible = await service.listReports(hr)

      // The NAME alone would describe a figure they are not entitled to.
      expect(visible.map((report) => report.name)).not.toContain(`Ageing ${suffix}`)
    })
  })

  describe('scheduling', () => {
    it('refuses a schedule without the permission', async () => {
      const db = getSystemDb()
      const user = await db.user.create({
        data: { email: `unsched-${suffix}@example.test`, name: 'unscheduler' },
        select: { id: true },
      })
      const membership = await db.membership.create({
        data: { organizationId: state.orgId, userId: user.id, status: 'ACTIVE' },
        select: { id: true },
      })
      const role = await db.role.findFirstOrThrow({
        where: { organizationId: null, key: 'manager' },
        select: { id: true },
      })
      await db.membershipRole.create({
        data: { organizationId: state.orgId, membershipId: membership.id, roleId: role.id },
      })

      state.users.unscheduler = user.id
      state.memberships.unscheduler = membership.id

      const manager = await makeCtx('unscheduler')
      expect(manager.can('report.schedule')).toBe(false)

      await expect(
        service.createReport(
          manager,
          { template: 'project-status', name: `Scheduled ${suffix}`, schedule: 'daily' },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('runs a due report and records when it ran', async () => {
      const owner = await makeCtx('owner')

      const saved = await service.createReport(
        owner,
        { template: 'project-status', name: `Daily status ${suffix}`, schedule: 'daily' },
        meta,
      )

      const result = await service.runDueReports()
      expect(result.ran).toBeGreaterThan(0)

      const row = await getSystemDb().report.findUniqueOrThrow({
        where: { id: saved.id },
        select: { lastRunAt: true, lastError: true },
      })

      expect(row.lastRunAt).not.toBeNull()
      expect(row.lastError).toBeNull()
    })

    it('does not run the same report twice within its interval', async () => {
      const owner = await makeCtx('owner')

      await service.createReport(
        owner,
        { template: 'team-workload', name: `Weekly workload ${suffix}`, schedule: 'weekly' },
        meta,
      )

      await service.runDueReports()
      const second = await service.runDueReports()

      // Everything due has just run, so nothing is due again.
      expect(second.ran).toBe(0)
    })
  })
})
