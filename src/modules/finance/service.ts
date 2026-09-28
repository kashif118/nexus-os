import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, forbidden, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { toPageResult, type ListParams } from '@/kernel/validation/list-params'

import { balanceOf, calculateInvoice, deriveStatus, type LineInput } from './calculate'
import * as repository from './repository'
import type { ExpenseSort, InvoiceSort } from './schema'

/**
 * Finance business rules.
 *
 * Three invariants hold here and nowhere else:
 *
 * 1. **Totals are computed, never accepted.** The client sends line items; the
 *    server computes subtotal, discount, tax, total and balance. A total the
 *    caller can choose is a total an attacker can choose.
 * 2. **Status is derived from facts.** An invoice is overdue because its due
 *    date passed with money outstanding, not because somebody set a dropdown.
 * 3. **An issued invoice is not freely editable.** Once sent, the line items are
 *    a statement to a customer; changing them silently is how disputes start.
 */

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

export interface InvoiceLineInput {
  description: string
  quantityScaled: number
  unitPriceMinor: bigint
  discountBasisPoints: number
  taxBasisPoints: number
}

const QUANTITY_SCALE = 3

/* -------------------------------------------------------------------------- */
/* Invoices                                                                    */
/* -------------------------------------------------------------------------- */

export async function listInvoices(
  ctx: Ctx,
  params: ListParams<InvoiceSort>,
  filters: { status?: string | undefined; companyId?: string | undefined } = {},
) {
  ctx.require('finance.invoice.read')
  const { items, total } = await repository.listInvoices(ctx, params, filters)
  return toPageResult(items, total, params)
}

export async function getInvoice(ctx: Ctx, id: string) {
  ctx.require('finance.invoice.read')
  const invoice = await repository.findInvoice(ctx, id)
  if (!invoice) throw notFound('That invoice is not available.')
  return invoice
}

export async function createInvoice(
  ctx: Ctx,
  input: {
    companyId: string
    contactId?: string | undefined
    projectId?: string | undefined
    issueDate: Date
    dueDate: Date
    notes?: string | undefined
    terms?: string | undefined
    lines: InvoiceLineInput[]
  },
  meta: RequestMeta,
): Promise<{ id: string; number: string }> {
  ctx.require('finance.invoice.create')

  const company = await repository.findCompany(ctx, input.companyId)
  if (!company)
    throw validationError('That client is not available.', { companyId: ['Unknown client.'] })

  if (input.projectId) {
    const project = await repository.findProject(ctx, input.projectId)
    if (!project) throw validationError('That project is not available.')
  }

  if (input.dueDate < input.issueDate) {
    throw validationError('The due date cannot be before the issue date.', {
      dueDate: ['Must be on or after the issue date.'],
    })
  }

  const totals = computeTotals(input.lines)
  const number = await repository.nextDocumentNumber(ctx.orgId, 'INVOICE', 'INV-')

  const invoice = await repository.createInvoice(ctx, {
    number,
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    projectId: input.projectId ?? null,
    status: 'DRAFT',
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    currency: ctx.org.currency,
    notes: input.notes ?? null,
    terms: input.terms ?? null,
    ...totals.invoice,
    amountPaidMinor: 0n,
    balanceMinor: totals.invoice.totalMinor,
  })

  await repository.replaceItems(ctx, invoice.id, totals.items)

  await writeAuditLog({
    action: 'finance.invoice.created',
    entityType: 'Invoice',
    entityId: invoice.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { number: invoice.number, totalMinor: totals.invoice.totalMinor.toString() },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: invoice.id, number: invoice.number }
}

export async function updateInvoice(
  ctx: Ctx,
  id: string,
  input: {
    companyId: string
    contactId?: string | undefined
    projectId?: string | undefined
    issueDate: Date
    dueDate: Date
    notes?: string | undefined
    terms?: string | undefined
    lines: InvoiceLineInput[]
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('finance.invoice.update')

  const invoice = await repository.findInvoice(ctx, id)
  if (!invoice) throw notFound('That invoice is not available.')

  // Once an invoice is a statement to a customer, its lines are not freely
  // editable. Correcting an issued invoice means voiding and reissuing.
  if (invoice.status !== 'DRAFT') {
    throw conflict(
      'This invoice has already been issued. Void it and raise a new one to make changes.',
    )
  }

  if (input.dueDate < input.issueDate) {
    throw validationError('The due date cannot be before the issue date.', {
      dueDate: ['Must be on or after the issue date.'],
    })
  }

  const totals = computeTotals(input.lines)

  await repository.updateInvoice(ctx, id, {
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    projectId: input.projectId ?? null,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    notes: input.notes ?? null,
    terms: input.terms ?? null,
    ...totals.invoice,
    balanceMinor: balanceOf(totals.invoice.totalMinor, invoice.amountPaidMinor),
  })

  await repository.replaceItems(ctx, id, totals.items)

  await writeAuditLog({
    action: 'finance.invoice.updated',
    entityType: 'Invoice',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/** Issue a draft. Approval is a separate permission from creation. */
export async function sendInvoice(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('finance.invoice.send')

  const invoice = await repository.findInvoice(ctx, id)
  if (!invoice) throw notFound('That invoice is not available.')
  if (invoice.status !== 'DRAFT') throw conflict('That invoice has already been issued.')
  if (invoice.items.length === 0) {
    throw validationError('An invoice needs at least one line before it can be sent.')
  }

  await repository.updateInvoice(ctx, id, {
    status: deriveStatus({
      current: 'SENT',
      totalMinor: invoice.totalMinor,
      amountPaidMinor: invoice.amountPaidMinor,
      dueDate: invoice.dueDate,
    }),
    sentAt: new Date(),
  })

  await writeAuditLog({
    action: 'finance.invoice.sent',
    entityType: 'Invoice',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { number: invoice.number },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function voidInvoice(
  ctx: Ctx,
  id: string,
  reason: string | undefined,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('finance.invoice.void')

  const invoice = await repository.findInvoice(ctx, id)
  if (!invoice) throw notFound('That invoice is not available.')
  if (invoice.status === 'CANCELLED') throw conflict('That invoice is already cancelled.')

  // Payments are financial records: an invoice with money against it is
  // reconciled, not erased.
  if (invoice.amountPaidMinor > 0n) {
    throw conflict(
      'This invoice has payments recorded against it and cannot be voided. Issue a credit note instead.',
    )
  }

  await repository.updateInvoice(ctx, id, {
    status: 'CANCELLED',
    voidedAt: new Date(),
    notes: reason
      ? `${invoice.notes ? `${invoice.notes}\n\n` : ''}Voided: ${reason}`
      : invoice.notes,
  })

  await writeAuditLog({
    action: 'finance.invoice.voided',
    entityType: 'Invoice',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { number: invoice.number, reason: reason ?? null },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteInvoice(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('finance.invoice.delete')

  const invoice = await repository.findInvoice(ctx, id)
  if (!invoice) throw notFound('That invoice is not available.')

  // Only a draft may be deleted; an issued invoice is part of the record.
  if (invoice.status !== 'DRAFT') {
    throw conflict('Only a draft invoice can be deleted. Void the issued invoice instead.')
  }

  await repository.softDeleteInvoice(ctx, id)

  await writeAuditLog({
    action: 'finance.invoice.deleted',
    entityType: 'Invoice',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Record a payment and re-derive the invoice state.
 *
 * The paid amount is summed from payment rows rather than incremented, so a
 * retried request cannot inflate it beyond what the rows actually say.
 */
export async function recordPayment(
  ctx: Ctx,
  input: {
    invoiceId: string
    amountMinor: bigint
    method: string
    receivedAt: Date
    reference?: string | undefined
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('finance.invoice.payment.record')

  if (input.amountMinor <= 0n) {
    throw validationError('A payment must be greater than zero.', {
      amountMinor: ['Enter an amount greater than zero.'],
    })
  }

  const invoice = await repository.findInvoice(ctx, input.invoiceId)
  if (!invoice) throw notFound('That invoice is not available.')
  if (invoice.status === 'DRAFT') {
    throw conflict('Send the invoice before recording a payment against it.')
  }
  if (invoice.status === 'CANCELLED') {
    throw conflict('That invoice has been cancelled.')
  }

  await repository.createPayment(ctx, {
    invoiceId: invoice.id,
    companyId: invoice.companyId,
    amountMinor: input.amountMinor,
    currency: invoice.currency,
    method: input.method,
    receivedAt: input.receivedAt,
    reference: input.reference ?? null,
  })

  const amountPaidMinor = await repository.sumPayments(ctx, invoice.id)

  await repository.updateInvoice(ctx, invoice.id, {
    amountPaidMinor,
    balanceMinor: balanceOf(invoice.totalMinor, amountPaidMinor),
    status: deriveStatus({
      current: invoice.status as never,
      totalMinor: invoice.totalMinor,
      amountPaidMinor,
      dueDate: invoice.dueDate,
    }),
    paidAt: amountPaidMinor >= invoice.totalMinor ? new Date() : null,
  })

  await writeAuditLog({
    action: 'finance.payment.recorded',
    entityType: 'Invoice',
    entityId: invoice.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { amountMinor: input.amountMinor.toString(), method: input.method },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Bring stored invoice statuses in line with the facts.
 *
 * Runs on demand from the finance screen today and from a scheduled job once the
 * job runner exists. Nothing else depends on it being timely: `deriveStatus` is
 * the authority, and this only caches its answer.
 */
export async function refreshInvoiceStatuses(ctx: Ctx): Promise<number> {
  ctx.require('finance.invoice.read')

  const invoices = await repository.invoicesNeedingStatusRefresh(ctx)
  let changed = 0

  for (const invoice of invoices) {
    const next = deriveStatus({
      current: invoice.status as never,
      totalMinor: invoice.totalMinor,
      amountPaidMinor: invoice.amountPaidMinor,
      dueDate: invoice.dueDate,
    })

    if (next !== invoice.status) {
      await repository.updateInvoice(ctx, invoice.id, { status: next })
      changed += 1
    }
  }

  return changed
}

/* -------------------------------------------------------------------------- */
/* Expenses                                                                    */
/* -------------------------------------------------------------------------- */

function expenseScope(ctx: Ctx): 'all' | 'own' {
  const scope = ctx.scope('finance.expense.read.any', 'finance.expense.read.own')
  if (scope === 'none') throw forbidden('You do not have access to expenses.')
  return scope
}

export async function listExpenses(
  ctx: Ctx,
  params: ListParams<ExpenseSort>,
  filters: { status?: string | undefined; projectId?: string | undefined } = {},
) {
  const scope = expenseScope(ctx)
  const { items, total } = await repository.listExpenses(ctx, params, { scope, ...filters })
  return toPageResult(items, total, params)
}

export async function getExpense(ctx: Ctx, id: string) {
  const scope = expenseScope(ctx)

  const expense = await repository.findExpense(ctx, id)
  if (!expense) throw notFound('That expense is not available.')

  // Someone with only `read.own` may not open a colleague's expense.
  if (scope === 'own' && expense.submittedByMembershipId !== ctx.membershipId) {
    throw notFound('That expense is not available.')
  }

  return expense
}

export async function createExpense(
  ctx: Ctx,
  input: {
    categoryId?: string | undefined
    projectId?: string | undefined
    vendor?: string | undefined
    description?: string | undefined
    amountMinor: bigint
    taxMinor: bigint
    incurredOn: Date
    /** Submit for approval immediately; otherwise it is saved as a draft. */
    submit?: boolean | undefined
  },
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('finance.expense.create')

  if (input.amountMinor <= 0n) {
    throw validationError('An expense must be greater than zero.', {
      amountMinor: ['Enter an amount greater than zero.'],
    })
  }

  if (input.categoryId) {
    const category = await repository.findExpenseCategory(ctx, input.categoryId)
    if (!category) throw validationError('That category is not available.')
  }

  if (input.projectId) {
    const project = await repository.findProject(ctx, input.projectId)
    if (!project) throw validationError('That project is not available.')
  }

  const expense = await repository.createExpense(ctx, {
    categoryId: input.categoryId ?? null,
    projectId: input.projectId ?? null,
    vendor: input.vendor ?? null,
    description: input.description ?? null,
    amountMinor: input.amountMinor,
    taxMinor: input.taxMinor,
    currency: ctx.org.currency,
    incurredOn: input.incurredOn,
    status: input.submit ? 'SUBMITTED' : 'DRAFT',
  })

  await writeAuditLog({
    action: 'finance.expense.created',
    entityType: 'Expense',
    entityId: expense.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { amountMinor: input.amountMinor.toString() },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: expense.id }
}

/**
 * Approve or reject an expense.
 *
 * Nobody may decide their own claim, regardless of permission. That is a
 * segregation-of-duties rule, not a UI nicety, so it lives here.
 */
export async function decideExpense(
  ctx: Ctx,
  input: { expenseId: string; approve: boolean; note?: string | undefined },
  meta: RequestMeta,
): Promise<void> {
  ctx.require(input.approve ? 'finance.expense.approve' : 'finance.expense.reject')

  const expense = await repository.findExpense(ctx, input.expenseId)
  if (!expense) throw notFound('That expense is not available.')

  if (expense.submittedByMembershipId === ctx.membershipId) {
    throw forbidden('You cannot approve your own expense claim.')
  }

  if (expense.status !== 'SUBMITTED') {
    throw conflict('Only a submitted expense can be decided.')
  }

  await repository.updateExpense(ctx, input.expenseId, {
    status: input.approve ? 'APPROVED' : 'REJECTED',
    approvedByMembershipId: ctx.membershipId,
    decidedAt: new Date(),
    decisionNote: input.note ?? null,
  })

  await writeAuditLog({
    action: input.approve ? 'finance.expense.approved' : 'finance.expense.rejected',
    entityType: 'Expense',
    entityId: input.expenseId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { amountMinor: expense.amountMinor.toString() },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function submitExpense(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('finance.expense.create')

  const expense = await repository.findExpense(ctx, id)
  if (!expense) throw notFound('That expense is not available.')
  if (expense.submittedByMembershipId !== ctx.membershipId && !ctx.can('finance.expense.update')) {
    throw forbidden('You can only submit your own expenses.')
  }
  if (expense.status !== 'DRAFT') throw conflict('That expense has already been submitted.')

  await repository.updateExpense(ctx, id, { status: 'SUBMITTED' })

  await writeAuditLog({
    action: 'finance.expense.submitted',
    entityType: 'Expense',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function listExpenseCategories(ctx: Ctx) {
  return repository.listExpenseCategories(ctx)
}

export async function createExpenseCategory(ctx: Ctx, name: string) {
  ctx.require('finance.budget.manage')
  try {
    return await repository.createExpenseCategory(ctx, name)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('That category already exists.', { name: ['Already in use.'] })
    }
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Budgets and summary                                                         */
/* -------------------------------------------------------------------------- */

export async function listBudgets(ctx: Ctx) {
  ctx.require('finance.budget.read')
  return repository.listBudgets(ctx)
}

export async function createBudget(
  ctx: Ctx,
  input: {
    scopeType: string
    scopeId?: string | undefined
    periodStart: Date
    periodEnd: Date
    amountMinor: bigint
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('finance.budget.manage')

  if (input.periodEnd < input.periodStart) {
    throw validationError('The period end cannot be before the start.', {
      periodEnd: ['Must be on or after the start.'],
    })
  }

  // A scope id arrives from a form and is therefore untrusted. It is resolved
  // through the org-scoped client, so an id belonging to another organization
  // simply does not exist here.
  if (input.scopeId) {
    const exists =
      input.scopeType === 'PROJECT'
        ? await ctx.db.project.findFirst({ where: { id: input.scopeId }, select: { id: true } })
        : input.scopeType === 'CATEGORY'
          ? await repository.findExpenseCategory(ctx, input.scopeId)
          : null

    if (!exists) {
      throw validationError('That budget scope is not available.', {
        scopeId: ['Choose something from the list.'],
      })
    }
  }

  await repository.createBudget(ctx, {
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    amountMinor: input.amountMinor,
    currency: ctx.org.currency,
  })

  await writeAuditLog({
    action: 'finance.budget.created',
    entityType: 'Budget',
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * The finance overview.
 *
 * Revenue is measured by PAYMENTS RECEIVED, not invoices raised: an invoice is a
 * claim, a payment is money. Mixing the two is how a dashboard shows revenue
 * that never arrived.
 */
export async function getFinancialSummary(ctx: Ctx, since?: Date) {
  ctx.require('finance.report.view')

  const from = since ?? startOfYear()

  const [revenue, expenses, byStatus, outstanding, payments] = await Promise.all([
    repository.revenueSince(ctx, from),
    repository.expensesSince(ctx, from),
    repository.invoiceTotalsByStatus(ctx),
    repository.outstandingInvoices(ctx),
    repository.listRecentPayments(ctx),
  ])

  return {
    currency: ctx.org.currency,
    periodStart: from,
    revenueMinor: revenue.total,
    expensesMinor: expenses.total,
    // Cash in less cash out. Not "profit": that needs accruals, which this
    // module does not model and should not pretend to.
    netMinor: revenue.total - expenses.total,
    invoicesByStatus: byStatus.map((row) => ({
      status: row.status,
      count: row._count._all,
      totalMinor: row._sum.totalMinor ?? 0n,
      balanceMinor: row._sum.balanceMinor ?? 0n,
    })),
    outstanding,
    payments,
  }
}

export const getFinanceFormOptions = (ctx: Ctx) => repository.financeFormOptions(ctx)

/* -------------------------------------------------------------------------- */

/** Compute invoice and line totals from input. */
function computeTotals(lines: InvoiceLineInput[]) {
  const inputs: LineInput[] = lines.map((line) => ({
    quantityScaled: line.quantityScaled,
    quantityScale: QUANTITY_SCALE,
    unitPriceMinor: line.unitPriceMinor,
    discountBasisPoints: line.discountBasisPoints,
    taxBasisPoints: line.taxBasisPoints,
  }))

  const { totals, lines: computed } = calculateInvoice(inputs)

  return {
    invoice: totals,
    items: lines.map((line, index) => ({
      description: line.description,
      quantityScaled: line.quantityScaled,
      quantityScale: QUANTITY_SCALE,
      unitPriceMinor: line.unitPriceMinor,
      discountBasisPoints: line.discountBasisPoints,
      taxBasisPoints: line.taxBasisPoints,
      ...computed[index]!,
    })),
  }
}

function startOfYear(): Date {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
