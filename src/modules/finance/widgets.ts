import { formatMoney } from '@/lib/money'

import { registerWidgets, type WidgetDefinition } from '../dashboard/registry'
import * as repository from './repository'

/**
 * Finance contributions to the Command Center.
 *
 * Every figure here is money, so every figure is read from stored minor units
 * and formatted once. Revenue means payments received; a widget that showed
 * invoices raised and called it revenue would be reporting a hope.
 *
 * The permissions gate before the resolver runs, so an Employee never triggers
 * the underlying aggregate at all.
 */

const startOfYear = () => new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))

export const FINANCE_WIDGETS: WidgetDefinition[] = [
  {
    id: 'finance.revenue',
    title: 'Revenue received',
    description: 'Payments banked this year, not invoices raised.',
    kind: 'stat',
    span: 3,
    module: 'finance',
    requires: ['finance.report.view'],
    resolve: async (ctx) => {
      const revenue = await repository.revenueSince(ctx, startOfYear())
      return {
        kind: 'stat',
        value: formatMoney(revenue.total, ctx.org.currency),
        detail:
          revenue.count === 0
            ? 'No payments yet this year'
            : `${revenue.count} payment${revenue.count === 1 ? '' : 's'} year to date`,
        href: `/${ctx.orgSlug}/finance`,
      }
    },
  },
  {
    id: 'finance.outstanding',
    title: 'Outstanding',
    description: 'Issued invoices still unpaid.',
    kind: 'stat',
    span: 3,
    module: 'finance',
    requires: ['finance.invoice.read'],
    resolve: async (ctx) => {
      const byStatus = await repository.invoiceTotalsByStatus(ctx)
      const open = byStatus.filter((row) => row.status === 'SENT' || row.status === 'OVERDUE')
      const balance = open.reduce((sum, row) => sum + (row._sum.balanceMinor ?? 0n), 0n)
      const overdue = byStatus.find((row) => row.status === 'OVERDUE')

      return {
        kind: 'stat',
        value: formatMoney(balance, ctx.org.currency),
        detail:
          overdue && overdue._count._all > 0
            ? `${overdue._count._all} overdue`
            : balance === 0n
              ? 'Nothing owed'
              : 'All within terms',
        href: `/${ctx.orgSlug}/finance/invoices`,
        ...(overdue && overdue._count._all > 0
          ? { trend: { direction: 'up' as const, label: 'Chase overdue', good: false } }
          : {}),
      }
    },
  },
  {
    id: 'finance.invoice.status',
    title: 'Invoices by status',
    description: 'Where billing currently sits.',
    kind: 'breakdown',
    span: 6,
    module: 'finance',
    requires: ['finance.invoice.read'],
    resolve: async (ctx) => {
      const byStatus = await repository.invoiceTotalsByStatus(ctx)
      const segments = ['DRAFT', 'SENT', 'OVERDUE', 'PAID', 'CANCELLED'].map((status) => ({
        label: status.charAt(0) + status.slice(1).toLowerCase(),
        value: byStatus.find((row) => row.status === status)?._count._all ?? 0,
      }))

      return {
        kind: 'breakdown',
        segments,
        total: segments.reduce((sum, segment) => sum + segment.value, 0),
        emptyLabel: 'No invoices raised yet.',
      }
    },
  },
  {
    id: 'finance.expenses.pending',
    title: 'Expenses awaiting approval',
    description: 'Submitted claims that nobody has decided.',
    kind: 'list',
    span: 6,
    module: 'finance',
    requires: ['finance.expense.approve', 'finance.expense.read.any'],
    resolve: async (ctx) => {
      const pending = await repository.pendingExpenses(ctx, 5)

      return {
        kind: 'list',
        items: pending.map((expense) => ({
          id: expense.id,
          title: expense.vendor ?? 'Expense claim',
          meta: `${expense.submittedBy?.user.name ?? 'Former member'} · ${expense.incurredOn.toISOString().slice(0, 10)}`,
          badge: {
            label: formatMoney(expense.amountMinor + expense.taxMinor, expense.currency),
            tone: 'neutral' as const,
          },
          href: `/${ctx.orgSlug}/finance/expenses?expense=${expense.id}`,
        })),
        emptyLabel: 'Nothing waiting on you.',
        href: `/${ctx.orgSlug}/finance/expenses?status=SUBMITTED`,
      }
    },
  },
]

registerWidgets(FINANCE_WIDGETS)
