import type { Ctx } from '@/kernel/tenancy/ctx'
import { containsInsensitive, type ListParams } from '@/kernel/validation/list-params'
import { getSystemDb } from '@/lib/db'

import type { ExpenseSort, InvoiceSort } from './schema'

const live = { deletedAt: null }

/* ------------------------------- numbering -------------------------------- */

/**
 * Claim the next document number atomically.
 *
 * A duplicate invoice number is an accounting problem, not a UI glitch, so this
 * is a single statement rather than read-then-write. Raw SQL, so it runs on the
 * system client with the organization bound as a parameter.
 */
export async function nextDocumentNumber(
  organizationId: string,
  kind: string,
  prefix: string,
): Promise<string> {
  const rows = await getSystemDb().$queryRaw<Array<{ lastValue: number; prefix: string }>>`
    INSERT INTO "NumberSequence" ("id", "organizationId", "kind", "prefix", "lastValue")
    VALUES (gen_random_uuid()::text, ${organizationId}, ${kind}, ${prefix}, 1)
    ON CONFLICT ("organizationId", "kind")
    DO UPDATE SET "lastValue" = "NumberSequence"."lastValue" + 1
    RETURNING "lastValue", "prefix"
  `

  const row = rows[0]
  const value = row?.lastValue ?? 1
  return `${row?.prefix ?? prefix}${String(value).padStart(4, '0')}`
}

/* -------------------------------- invoices -------------------------------- */

export async function listInvoices(
  ctx: Ctx,
  params: ListParams<InvoiceSort>,
  filters: {
    status?: string | undefined
    companyId?: string | undefined
    projectId?: string | undefined
  } = {},
) {
  const where = {
    ...live,
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.companyId ? { companyId: filters.companyId } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(params.q
      ? {
          OR: [
            { number: containsInsensitive(params.q) },
            { company: { name: containsInsensitive(params.q) } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.invoice.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        number: true,
        status: true,
        issueDate: true,
        dueDate: true,
        currency: true,
        totalMinor: true,
        amountPaidMinor: true,
        balanceMinor: true,
        company: { select: { id: true, name: true } },
        project: { select: { id: true, key: true } },
      },
    }),
    ctx.db.invoice.count({ where }),
  ])

  return { items, total }
}

export async function findInvoice(ctx: Ctx, id: string) {
  return ctx.db.invoice.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      number: true,
      status: true,
      issueDate: true,
      dueDate: true,
      sentAt: true,
      paidAt: true,
      currency: true,
      subtotalMinor: true,
      discountMinor: true,
      taxMinor: true,
      totalMinor: true,
      amountPaidMinor: true,
      balanceMinor: true,
      notes: true,
      terms: true,
      companyId: true,
      contactId: true,
      projectId: true,
      company: { select: { id: true, name: true } },
      contact: { select: { id: true, firstName: true, lastName: true, email: true } },
      project: { select: { id: true, key: true, name: true } },
      items: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          description: true,
          quantityScaled: true,
          quantityScale: true,
          unitPriceMinor: true,
          discountBasisPoints: true,
          taxBasisPoints: true,
          lineSubtotalMinor: true,
          lineDiscountMinor: true,
          lineTaxMinor: true,
          lineTotalMinor: true,
          position: true,
        },
      },
      payments: {
        orderBy: { receivedAt: 'desc' },
        select: {
          id: true,
          amountMinor: true,
          currency: true,
          method: true,
          receivedAt: true,
          reference: true,
        },
      },
    },
  })
}

export async function createInvoice(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.invoice.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, number: true },
  })
}

export async function updateInvoice(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.invoice.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteInvoice(ctx: Ctx, id: string) {
  const result = await ctx.db.invoice.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

export async function replaceItems(
  ctx: Ctx,
  invoiceId: string,
  items: Array<Record<string, unknown>>,
) {
  await ctx.db.invoiceItem.deleteMany({ where: { invoiceId } })
  if (items.length === 0) return

  await ctx.db.invoiceItem.createMany({
    data: items.map((item, index) => ({
      ...item,
      organizationId: ctx.orgId,
      invoiceId,
      position: index,
    })) as never,
  })
}

/* -------------------------------- payments -------------------------------- */

export async function createPayment(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.payment.create({
    data: { ...data, organizationId: ctx.orgId, recordedById: ctx.userId } as never,
    select: { id: true },
  })
}

export async function sumPayments(ctx: Ctx, invoiceId: string): Promise<bigint> {
  const result = await ctx.db.payment.aggregate({
    where: { invoiceId },
    _sum: { amountMinor: true },
  })
  return result._sum.amountMinor ?? 0n
}

export async function listRecentPayments(ctx: Ctx, limit = 10) {
  return ctx.db.payment.findMany({
    orderBy: { receivedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      amountMinor: true,
      currency: true,
      receivedAt: true,
      method: true,
      invoice: { select: { id: true, number: true } },
      company: { select: { id: true, name: true } },
    },
  })
}

/* -------------------------------- expenses -------------------------------- */

export async function listExpenses(
  ctx: Ctx,
  params: ListParams<ExpenseSort>,
  filters: {
    scope: 'all' | 'own'
    status?: string | undefined
    projectId?: string | undefined
    categoryId?: string | undefined
  },
) {
  const where = {
    ...live,
    // An Employee sees only their own expenses; the restriction is in the query.
    ...(filters.scope === 'own' ? { submittedByMembershipId: ctx.membershipId } : {}),
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(params.q
      ? {
          OR: [
            { vendor: containsInsensitive(params.q) },
            { description: containsInsensitive(params.q) },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.expense.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        vendor: true,
        description: true,
        amountMinor: true,
        taxMinor: true,
        currency: true,
        incurredOn: true,
        status: true,
        category: { select: { id: true, name: true } },
        project: { select: { id: true, key: true } },
        submittedBy: { select: { id: true, user: { select: { name: true } } } },
      },
    }),
    ctx.db.expense.count({ where }),
  ])

  return { items, total }
}

export async function findExpense(ctx: Ctx, id: string) {
  return ctx.db.expense.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      vendor: true,
      description: true,
      amountMinor: true,
      taxMinor: true,
      currency: true,
      incurredOn: true,
      status: true,
      categoryId: true,
      projectId: true,
      submittedByMembershipId: true,
      decisionNote: true,
      decidedAt: true,
      category: { select: { id: true, name: true } },
      project: { select: { id: true, key: true, name: true } },
      submittedBy: { select: { id: true, user: { select: { name: true } } } },
      approvedBy: { select: { id: true, user: { select: { name: true } } } },
    },
  })
}

export async function createExpense(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.expense.create({
    data: {
      ...data,
      organizationId: ctx.orgId,
      submittedByMembershipId: ctx.membershipId,
    } as never,
    select: { id: true },
  })
}

export async function updateExpense(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.expense.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function listExpenseCategories(ctx: Ctx) {
  return ctx.db.expenseCategory.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
}

export async function createExpenseCategory(ctx: Ctx, name: string) {
  return ctx.db.expenseCategory.create({
    data: { organizationId: ctx.orgId, name },
    select: { id: true, name: true },
  })
}

export async function findExpenseCategory(ctx: Ctx, id: string) {
  return ctx.db.expenseCategory.findFirst({ where: { id }, select: { id: true } })
}

/* --------------------------------- budgets -------------------------------- */

export async function listBudgets(ctx: Ctx) {
  return ctx.db.budget.findMany({
    orderBy: { periodStart: 'desc' },
    select: {
      id: true,
      scopeType: true,
      scopeId: true,
      periodStart: true,
      periodEnd: true,
      amountMinor: true,
      currency: true,
    },
  })
}

export async function createBudget(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.budget.create({
    data: { ...data, organizationId: ctx.orgId } as never,
    select: { id: true },
  })
}

/* ------------------------------- aggregates ------------------------------- */

export async function revenueSince(ctx: Ctx, since: Date) {
  const result = await ctx.db.payment.aggregate({
    where: { receivedAt: { gte: since } },
    _sum: { amountMinor: true },
    _count: { _all: true },
  })
  return { total: result._sum.amountMinor ?? 0n, count: result._count._all }
}

export async function expensesSince(ctx: Ctx, since: Date) {
  const result = await ctx.db.expense.aggregate({
    where: { ...live, incurredOn: { gte: since }, status: { in: ['APPROVED', 'REIMBURSED'] } },
    _sum: { amountMinor: true },
    _count: { _all: true },
  })
  return { total: result._sum.amountMinor ?? 0n, count: result._count._all }
}

export async function invoiceTotalsByStatus(ctx: Ctx) {
  return ctx.db.invoice.groupBy({
    by: ['status'],
    where: live,
    _sum: { totalMinor: true, balanceMinor: true },
    _count: { _all: true },
  })
}

export async function outstandingInvoices(ctx: Ctx, limit = 5) {
  return ctx.db.invoice.findMany({
    where: { ...live, status: { in: ['SENT', 'OVERDUE'] }, balanceMinor: { gt: 0 } },
    orderBy: { dueDate: 'asc' },
    take: limit,
    select: {
      id: true,
      number: true,
      dueDate: true,
      balanceMinor: true,
      currency: true,
      status: true,
      company: { select: { name: true } },
    },
  })
}

/** Invoices whose stored status disagrees with the facts, for the sweep. */
export async function invoicesNeedingStatusRefresh(ctx: Ctx, limit = 500) {
  return ctx.db.invoice.findMany({
    where: { ...live, status: { in: ['SENT', 'OVERDUE'] } },
    take: limit,
    select: {
      id: true,
      status: true,
      totalMinor: true,
      amountPaidMinor: true,
      dueDate: true,
    },
  })
}

export async function expensesByCategory(ctx: Ctx, since: Date) {
  return ctx.db.expense.groupBy({
    by: ['categoryId'],
    where: { ...live, incurredOn: { gte: since }, status: { in: ['APPROVED', 'REIMBURSED'] } },
    _sum: { amountMinor: true },
  })
}

/** Approved spend against a project, for budget tracking and project health. */
export async function projectSpend(ctx: Ctx, projectId: string): Promise<bigint> {
  const result = await ctx.db.expense.aggregate({
    where: { ...live, projectId, status: { in: ['APPROVED', 'REIMBURSED'] } },
    _sum: { amountMinor: true },
  })
  return result._sum.amountMinor ?? 0n
}

export async function findCompany(ctx: Ctx, id: string) {
  return ctx.db.company.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
}

export async function findProject(ctx: Ctx, id: string) {
  return ctx.db.project.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
}

export async function financeFormOptions(ctx: Ctx) {
  const [companies, projects, categories] = await Promise.all([
    ctx.db.company.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      take: 200,
      select: { id: true, name: true },
    }),
    ctx.db.project.findMany({
      where: { deletedAt: null, status: { notIn: ['ARCHIVED'] } },
      orderBy: { name: 'asc' },
      take: 200,
      select: { id: true, key: true, name: true },
    }),
    listExpenseCategories(ctx),
  ])

  return { companies, projects, categories }
}

/** Submitted claims awaiting a decision, for the approval queue widget. */
export async function pendingExpenses(ctx: Ctx, limit = 5) {
  return ctx.db.expense.findMany({
    where: { ...live, status: 'SUBMITTED' },
    orderBy: { incurredOn: 'asc' },
    take: limit,
    select: {
      id: true,
      vendor: true,
      amountMinor: true,
      taxMinor: true,
      currency: true,
      incurredOn: true,
      submittedBy: { select: { user: { select: { name: true } } } },
    },
  })
}
