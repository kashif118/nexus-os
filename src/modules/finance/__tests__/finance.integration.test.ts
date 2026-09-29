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
 * Finance against a real database.
 *
 * The properties under test are the ones that cost money when they are wrong:
 *
 * - totals are computed by the server, never accepted from the caller;
 * - an issued invoice is not editable, and not voidable once paid;
 * - the paid amount is the sum of the payment rows;
 * - nobody approves their own expense claim;
 * - an Employee sees only their own claims;
 * - one organization cannot read another's invoices.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `finance-${suffix}`
const OTHER_SLUG = `finance-other-${suffix}`
const meta = { ip: null, userAgent: 'vitest-finance' }

/** Dates relative to now, so derived statuses do not depend on the calendar. */
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000)

const state = {
  orgId: '',
  otherOrgId: '',
  companyId: '',
  otherCompanyId: '',
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
    org: {
      id: orgId,
      slug,
      name: 'Finance Org',
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
    data: { name: slug, slug, createdById: owner.id, currency: 'USD' },
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

/** A simple one-line invoice input. */
const lines = (unitPriceMinor: bigint, taxBasisPoints = 0, discountBasisPoints = 0) => [
  {
    description: 'Consulting',
    quantityScaled: 1_000, // 1.000
    unitPriceMinor,
    discountBasisPoints,
    taxBasisPoints,
  },
]

describe.skipIf(!hasDatabase)('Finance', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    state.orgId = await seedOrg(SLUG, 'owner')
    state.otherOrgId = await seedOrg(OTHER_SLUG, 'otherOwner')

    await seedMember('finance', 'finance_manager')
    await seedMember('manager', 'manager')
    await seedMember('employee', 'employee')
    await seedMember('employee2', 'employee')

    const company = await db.company.create({
      data: { organizationId: state.orgId, name: 'Acme Ltd' },
      select: { id: true },
    })
    state.companyId = company.id

    const otherCompany = await db.company.create({
      data: { organizationId: state.otherOrgId, name: 'Other Ltd' },
      select: { id: true },
    })
    state.otherCompanyId = otherCompany.id
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('invoice totals', () => {
    it('computes totals on the server rather than trusting the caller', async () => {
      const ctx = await makeCtx('finance')

      const created = await service.createInvoice(
        ctx,
        {
          companyId: state.companyId,
          issueDate: new Date('2026-01-10T00:00:00Z'),
          dueDate: new Date('2026-02-09T00:00:00Z'),
          // 2 units at 125.00 with 10% discount and 20% tax.
          lines: [
            {
              description: 'Retainer',
              quantityScaled: 2_000,
              unitPriceMinor: 12_500n,
              discountBasisPoints: 1_000,
              taxBasisPoints: 2_000,
            },
          ],
        },
        meta,
      )

      const invoice = await service.getInvoice(ctx, created.id)

      // 2 x 125.00 = 250.00; less 10% = 225.00; plus 20% tax = 270.00
      expect(invoice.subtotalMinor).toBe(25_000n)
      expect(invoice.discountMinor).toBe(2_500n)
      expect(invoice.taxMinor).toBe(4_500n)
      expect(invoice.totalMinor).toBe(27_000n)
      expect(invoice.balanceMinor).toBe(27_000n)
      expect(invoice.status).toBe('DRAFT')
    })

    it('assigns sequential, gap-free numbers', async () => {
      const ctx = await makeCtx('finance')
      const first = await service.createInvoice(
        ctx,
        {
          companyId: state.companyId,
          issueDate: new Date('2026-01-11T00:00:00Z'),
          dueDate: new Date('2026-02-10T00:00:00Z'),
          lines: lines(10_000n),
        },
        meta,
      )
      const second = await service.createInvoice(
        ctx,
        {
          companyId: state.companyId,
          issueDate: new Date('2026-01-12T00:00:00Z'),
          dueDate: new Date('2026-02-11T00:00:00Z'),
          lines: lines(10_000n),
        },
        meta,
      )

      const firstNumber = Number(first.number.replace(/\D/g, ''))
      const secondNumber = Number(second.number.replace(/\D/g, ''))
      expect(secondNumber).toBe(firstNumber + 1)
    })
  })

  describe('lifecycle', () => {
    it('refuses to edit an issued invoice', async () => {
      const ctx = await makeCtx('finance')
      const created = await service.createInvoice(
        ctx,
        {
          companyId: state.companyId,
          issueDate: new Date('2026-01-13T00:00:00Z'),
          dueDate: new Date('2026-02-12T00:00:00Z'),
          lines: lines(50_000n),
        },
        meta,
      )

      await service.sendInvoice(ctx, created.id, meta)

      await expect(
        service.updateInvoice(
          ctx,
          created.id,
          {
            companyId: state.companyId,
            issueDate: new Date('2026-01-13T00:00:00Z'),
            dueDate: new Date('2026-02-12T00:00:00Z'),
            lines: lines(1n),
          },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'CONFLICT')
    })

    it('derives PAID from the payments, and refuses to void a paid invoice', async () => {
      const ctx = await makeCtx('finance')
      const created = await service.createInvoice(
        ctx,
        {
          companyId: state.companyId,
          issueDate: daysFromNow(-1),
          dueDate: daysFromNow(30),
          lines: lines(30_000n),
        },
        meta,
      )
      await service.sendInvoice(ctx, created.id, meta)

      // Two part payments settling the invoice exactly.
      await service.recordPayment(
        ctx,
        {
          invoiceId: created.id,
          amountMinor: 10_000n,
          method: 'BANK_TRANSFER',
          receivedAt: daysFromNow(0),
        },
        meta,
      )

      const partial = await service.getInvoice(ctx, created.id)
      expect(partial.amountPaidMinor).toBe(10_000n)
      expect(partial.balanceMinor).toBe(20_000n)
      expect(partial.status).toBe('SENT')

      await service.recordPayment(
        ctx,
        {
          invoiceId: created.id,
          amountMinor: 20_000n,
          method: 'BANK_TRANSFER',
          receivedAt: daysFromNow(0),
        },
        meta,
      )

      const settled = await service.getInvoice(ctx, created.id)
      expect(settled.amountPaidMinor).toBe(30_000n)
      expect(settled.balanceMinor).toBe(0n)
      expect(settled.status).toBe('PAID')
      expect(settled.paidAt).not.toBeNull()

      await expect(service.voidInvoice(ctx, created.id, 'mistake', meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
    })

    it('only deletes drafts', async () => {
      const ctx = await makeCtx('finance')
      const draft = await service.createInvoice(
        ctx,
        {
          companyId: state.companyId,
          issueDate: new Date('2026-01-15T00:00:00Z'),
          dueDate: new Date('2026-02-14T00:00:00Z'),
          lines: lines(1_000n),
        },
        meta,
      )
      await service.deleteInvoice(ctx, draft.id, meta)
      await expect(service.getInvoice(ctx, draft.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )

      const issued = await service.createInvoice(
        ctx,
        {
          companyId: state.companyId,
          issueDate: new Date('2026-01-16T00:00:00Z'),
          dueDate: new Date('2026-02-15T00:00:00Z'),
          lines: lines(1_000n),
        },
        meta,
      )
      await service.sendInvoice(ctx, issued.id, meta)
      await expect(service.deleteInvoice(ctx, issued.id, meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
    })
  })

  describe('authorization', () => {
    it('refuses invoice creation without the permission', async () => {
      const employee = await makeCtx('employee')
      await expect(
        service.createInvoice(
          employee,
          {
            companyId: state.companyId,
            issueDate: new Date('2026-01-17T00:00:00Z'),
            dueDate: new Date('2026-02-16T00:00:00Z'),
            lines: lines(1_000n),
          },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('refuses the financial summary to an Employee', async () => {
      const employee = await makeCtx('employee')
      await expect(service.getFinancialSummary(employee)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })
  })

  describe('expenses', () => {
    it('shows an Employee only their own claims', async () => {
      const employee = await makeCtx('employee')
      const other = await makeCtx('employee2')

      await service.createExpense(
        employee,
        { amountMinor: 2_500n, taxMinor: 0n, incurredOn: new Date('2026-01-18T00:00:00Z') },
        meta,
      )
      await service.createExpense(
        other,
        { amountMinor: 9_900n, taxMinor: 0n, incurredOn: new Date('2026-01-18T00:00:00Z') },
        meta,
      )

      const params = {
        page: 1,
        pageSize: 25,
        skip: 0,
        take: 25,
        sort: { field: 'incurredOn' as const, direction: 'desc' as const },
        q: undefined,
      }

      const mine = await service.listExpenses(employee, params)
      expect(mine.items).toHaveLength(1)
      expect(mine.items[0]?.amountMinor).toBe(2_500n)

      const all = await service.listExpenses(await makeCtx('finance'), params)
      expect(all.items.length).toBeGreaterThanOrEqual(2)
    })

    it('hides a colleague’s claim behind NOT_FOUND, not FORBIDDEN', async () => {
      const employee = await makeCtx('employee')
      const other = await makeCtx('employee2')

      const claim = await service.createExpense(
        other,
        { amountMinor: 4_200n, taxMinor: 0n, incurredOn: new Date('2026-01-19T00:00:00Z') },
        meta,
      )

      await expect(service.getExpense(employee, claim.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('refuses to let anyone approve their own claim', async () => {
      const financeManager = await makeCtx('finance')

      const own = await service.createExpense(
        financeManager,
        {
          amountMinor: 7_000n,
          taxMinor: 0n,
          incurredOn: new Date('2026-01-20T00:00:00Z'),
          submit: true,
        },
        meta,
      )

      await expect(
        service.decideExpense(financeManager, { expenseId: own.id, approve: true }, meta),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('lets a different approver decide, and records who decided', async () => {
      const employee = await makeCtx('employee')
      const financeManager = await makeCtx('finance')

      const claim = await service.createExpense(
        employee,
        {
          amountMinor: 3_300n,
          taxMinor: 0n,
          incurredOn: new Date('2026-01-21T00:00:00Z'),
          submit: true,
        },
        meta,
      )

      await service.decideExpense(
        financeManager,
        { expenseId: claim.id, approve: true, note: 'Fine' },
        meta,
      )

      const decided = await service.getExpense(financeManager, claim.id)
      expect(decided.status).toBe('APPROVED')
      expect(decided.approvedBy?.id).toBe(state.memberships.finance)
    })
  })

  describe('tenant isolation', () => {
    it('cannot read another organization’s invoice', async () => {
      const ctx = await makeCtx('finance')
      const otherCtx = await makeCtx('otherOwner', state.otherOrgId, OTHER_SLUG)

      const theirs = await service.createInvoice(
        otherCtx,
        {
          companyId: state.otherCompanyId,
          issueDate: new Date('2026-01-22T00:00:00Z'),
          dueDate: new Date('2026-02-21T00:00:00Z'),
          lines: lines(99_900n),
        },
        meta,
      )

      await expect(service.getInvoice(ctx, theirs.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('refuses an invoice raised against another organization’s company', async () => {
      const ctx = await makeCtx('finance')

      await expect(
        service.createInvoice(
          ctx,
          {
            companyId: state.otherCompanyId,
            issueDate: new Date('2026-01-23T00:00:00Z'),
            dueDate: new Date('2026-02-22T00:00:00Z'),
            lines: lines(1_000n),
          },
          meta,
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'VALIDATION_ERROR'),
      )
    })

    it('keeps invoice numbering independent per organization', async () => {
      const otherCtx = await makeCtx('otherOwner', state.otherOrgId, OTHER_SLUG)
      const created = await service.createInvoice(
        otherCtx,
        {
          companyId: state.otherCompanyId,
          issueDate: new Date('2026-01-24T00:00:00Z'),
          dueDate: new Date('2026-02-23T00:00:00Z'),
          lines: lines(1_000n),
        },
        meta,
      )

      // The other organization is on its own sequence, so its numbers are low
      // even though this org has already issued several.
      expect(Number(created.number.replace(/\D/g, ''))).toBeLessThan(5)
    })
  })

  describe('summary', () => {
    it('measures revenue by payments received, not invoices raised', async () => {
      const ctx = await makeCtx('finance')
      const summary = await service.getFinancialSummary(ctx, daysFromNow(-2))

      // Only the 300.00 invoice was actually paid, in two instalments.
      expect(summary.revenueMinor).toBe(30_000n)
      expect(summary.netMinor).toBe(summary.revenueMinor - summary.expensesMinor)
    })
  })
})
