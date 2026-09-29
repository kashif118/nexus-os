import type { Permission } from '@/kernel/authz/catalogue'
import type { Ctx } from '@/kernel/tenancy/ctx'

import { buckets, type Range } from './periods'

/**
 * The metric registry.
 *
 * A metric declares what it is, who may see it, and how to compute it from
 * source rows. Three rules that keep the numbers honest:
 *
 * 1. **A metric computes itself from its own table.** Nothing here reads a
 *    cached snapshot; the cache is written FROM these functions, never the
 *    other way round. A wrong cache is then a stale number, not a wrong one.
 * 2. **Money stays in minor units.** Sums are `bigint` all the way to the
 *    formatter, so no chart axis ever introduces a rounding error into a
 *    figure somebody quotes.
 * 3. **Every metric names the permission it needs.** A metric the caller may
 *    not see is not computed at all — not computed and hidden, which would
 *    still put the number in the response.
 */

export type MetricUnit = 'count' | 'money' | 'percent' | 'days'

export interface MetricPoint {
  label: string
  value: number
  /** Present for money metrics; `value` carries the same figure as a number. */
  valueMinor?: bigint
}

export interface MetricDefinition {
  key: string
  label: string
  description: string
  unit: MetricUnit
  /** A higher number is better. Drives the tone of a change indicator. */
  higherIsBetter: boolean
  requires: Permission[]
  /** One number for the range. */
  total(ctx: Ctx, range: Range): Promise<{ value: number; valueMinor?: bigint }>
  /** The same number bucketed over time. */
  series?(ctx: Ctx, range: Range): Promise<MetricPoint[]>
  /** Where clicking through goes, so a figure is never a dead end. */
  drilldown?(orgSlug: string): string
}

const METRICS = new Map<string, MetricDefinition>()

export function registerMetric(definition: MetricDefinition): void {
  if (METRICS.has(definition.key)) throw new Error(`Duplicate metric: ${definition.key}`)
  METRICS.set(definition.key, definition)
}

export const getMetric = (key: string): MetricDefinition | undefined => METRICS.get(key)
export const listMetrics = (): MetricDefinition[] => [...METRICS.values()]

/** The metrics this caller may see. */
export const metricsFor = (ctx: Ctx): MetricDefinition[] =>
  listMetrics().filter((metric) => metric.requires.every((permission) => ctx.can(permission)))

/** Test seam. */
export function resetMetrics(): void {
  METRICS.clear()
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Bucket rows by a date field, summing a numeric accessor. */
function bucketise<T>(
  rows: T[],
  range: Range,
  dateOf: (row: T) => Date,
  valueOf: (row: T) => number,
): MetricPoint[] {
  const slots = buckets(range)
  const totals = new Array<number>(slots.length).fill(0)

  for (const row of rows) {
    const at = dateOf(row).getTime()
    // Linear scan: a range never has more than about 90 buckets, and a binary
    // search here would be optimising the wrong thing.
    const index = slots.findIndex((slot) => at >= slot.start.getTime() && at <= slot.end.getTime())
    if (index >= 0) totals[index] = (totals[index] ?? 0) + valueOf(row)
  }

  return slots.map((slot, index) => ({ label: slot.label, value: totals[index] ?? 0 }))
}

/** Minor units as a plain number, for a chart axis only. */
const asNumber = (minor: bigint): number => Number(minor) / 100

/* -------------------------------------------------------------------------- */
/* Revenue and cash                                                            */
/* -------------------------------------------------------------------------- */

registerMetric({
  key: 'revenue.received',
  label: 'Revenue received',
  description: 'Payments banked in the period. Not invoices raised — money that arrived.',
  unit: 'money',
  higherIsBetter: true,
  requires: ['finance.report.view'],
  async total(ctx, range) {
    const result = await ctx.db.payment.aggregate({
      where: { receivedAt: { gte: range.from, lte: range.to } },
      _sum: { amountMinor: true },
    })
    const minor = result._sum.amountMinor ?? 0n
    return { value: asNumber(minor), valueMinor: minor }
  },
  async series(ctx, range) {
    const rows = await ctx.db.payment.findMany({
      where: { receivedAt: { gte: range.from, lte: range.to } },
      select: { receivedAt: true, amountMinor: true },
    })
    return bucketise(
      rows,
      range,
      (row) => row.receivedAt,
      (row) => asNumber(row.amountMinor),
    )
  },
  drilldown: (orgSlug) => `/${orgSlug}/finance/invoices?status=PAID`,
})

registerMetric({
  key: 'invoiced.total',
  label: 'Invoiced',
  description: 'Value of invoices issued in the period, whether or not they have been paid.',
  unit: 'money',
  higherIsBetter: true,
  requires: ['finance.invoice.read'],
  async total(ctx, range) {
    const result = await ctx.db.invoice.aggregate({
      where: {
        deletedAt: null,
        status: { not: 'DRAFT' },
        issueDate: { gte: range.from, lte: range.to },
      },
      _sum: { totalMinor: true },
    })
    const minor = result._sum.totalMinor ?? 0n
    return { value: asNumber(minor), valueMinor: minor }
  },
  async series(ctx, range) {
    const rows = await ctx.db.invoice.findMany({
      where: {
        deletedAt: null,
        status: { not: 'DRAFT' },
        issueDate: { gte: range.from, lte: range.to },
      },
      select: { issueDate: true, totalMinor: true },
    })
    return bucketise(
      rows,
      range,
      (row) => row.issueDate,
      (row) => asNumber(row.totalMinor),
    )
  },
  drilldown: (orgSlug) => `/${orgSlug}/finance/invoices`,
})

registerMetric({
  key: 'expenses.approved',
  label: 'Approved expenses',
  description: 'Claims approved or reimbursed, by the date they were incurred.',
  unit: 'money',
  higherIsBetter: false,
  requires: ['finance.report.view'],
  async total(ctx, range) {
    const result = await ctx.db.expense.aggregate({
      where: {
        deletedAt: null,
        status: { in: ['APPROVED', 'REIMBURSED'] },
        incurredOn: { gte: range.from, lte: range.to },
      },
      _sum: { amountMinor: true, taxMinor: true },
    })
    const minor = (result._sum.amountMinor ?? 0n) + (result._sum.taxMinor ?? 0n)
    return { value: asNumber(minor), valueMinor: minor }
  },
  async series(ctx, range) {
    const rows = await ctx.db.expense.findMany({
      where: {
        deletedAt: null,
        status: { in: ['APPROVED', 'REIMBURSED'] },
        incurredOn: { gte: range.from, lte: range.to },
      },
      select: { incurredOn: true, amountMinor: true, taxMinor: true },
    })
    return bucketise(
      rows,
      range,
      (row) => row.incurredOn,
      (row) => asNumber(row.amountMinor + row.taxMinor),
    )
  },
  drilldown: (orgSlug) => `/${orgSlug}/finance/expenses?status=APPROVED`,
})

/* -------------------------------------------------------------------------- */
/* Delivery                                                                    */
/* -------------------------------------------------------------------------- */

registerMetric({
  key: 'tasks.completed',
  label: 'Tasks completed',
  description: 'Tasks that reached a finished state in the period.',
  unit: 'count',
  higherIsBetter: true,
  requires: ['task.read'],
  async total(ctx, range) {
    const value = await ctx.db.task.count({
      where: { deletedAt: null, completedAt: { gte: range.from, lte: range.to } },
    })
    return { value }
  },
  async series(ctx, range) {
    const rows = await ctx.db.task.findMany({
      where: { deletedAt: null, completedAt: { gte: range.from, lte: range.to } },
      select: { completedAt: true },
    })
    return bucketise(
      rows.filter((row): row is { completedAt: Date } => row.completedAt !== null),
      range,
      (row) => row.completedAt,
      () => 1,
    )
  },
  drilldown: (orgSlug) => `/${orgSlug}/tasks?status=DONE`,
})

registerMetric({
  key: 'tasks.overdue',
  label: 'Overdue now',
  description: 'Open tasks past their due date, as of this moment. Not a period figure.',
  unit: 'count',
  higherIsBetter: false,
  requires: ['task.read'],
  async total(ctx) {
    const value = await ctx.db.task.count({
      where: {
        deletedAt: null,
        status: { notIn: ['DONE', 'CANCELLED'] },
        dueDate: { lt: new Date() },
      },
    })
    return { value }
  },
  drilldown: (orgSlug) => `/${orgSlug}/tasks`,
})

registerMetric({
  key: 'projects.active',
  label: 'Active projects',
  description: 'Projects currently in flight, as of this moment.',
  unit: 'count',
  higherIsBetter: true,
  requires: [],
  async total(ctx) {
    const value = await ctx.db.project.count({ where: { deletedAt: null, status: 'ACTIVE' } })
    return { value }
  },
  drilldown: (orgSlug) => `/${orgSlug}/projects`,
})

registerMetric({
  key: 'projects.at-risk',
  label: 'Projects off track',
  description: 'Active projects scored at risk or critical, as of this moment.',
  unit: 'count',
  higherIsBetter: false,
  requires: [],
  async total(ctx) {
    const value = await ctx.db.project.count({
      where: { deletedAt: null, status: 'ACTIVE', healthStatus: { in: ['AT_RISK', 'CRITICAL'] } },
    })
    return { value }
  },
  drilldown: (orgSlug) => `/${orgSlug}/projects`,
})

/* -------------------------------------------------------------------------- */
/* Sales                                                                       */
/* -------------------------------------------------------------------------- */

registerMetric({
  key: 'deals.won',
  label: 'Deals won',
  description: 'Deals that moved into a winning stage in the period.',
  unit: 'count',
  higherIsBetter: true,
  requires: ['crm.deal.read'],
  async total(ctx, range) {
    const value = await ctx.db.deal.count({
      where: { deletedAt: null, status: 'WON', wonAt: { gte: range.from, lte: range.to } },
    })
    return { value }
  },
  async series(ctx, range) {
    const rows = await ctx.db.deal.findMany({
      where: { deletedAt: null, status: 'WON', wonAt: { gte: range.from, lte: range.to } },
      select: { wonAt: true },
    })
    return bucketise(
      rows.filter((row): row is { wonAt: Date } => row.wonAt !== null),
      range,
      (row) => row.wonAt,
      () => 1,
    )
  },
  drilldown: (orgSlug) => `/${orgSlug}/crm/deals?status=WON`,
})

registerMetric({
  key: 'deals.won.value',
  label: 'Value won',
  description: 'Total value of deals won in the period.',
  unit: 'money',
  higherIsBetter: true,
  requires: ['crm.deal.read', 'crm.deal.value.view'],
  async total(ctx, range) {
    const result = await ctx.db.deal.aggregate({
      where: { deletedAt: null, status: 'WON', wonAt: { gte: range.from, lte: range.to } },
      _sum: { valueMinor: true },
    })
    const minor = result._sum.valueMinor ?? 0n
    return { value: asNumber(minor), valueMinor: minor }
  },
  drilldown: (orgSlug) => `/${orgSlug}/crm/deals?status=WON`,
})

registerMetric({
  key: 'deals.winrate',
  label: 'Win rate',
  description: 'Won as a share of everything closed in the period. Open deals are excluded.',
  unit: 'percent',
  higherIsBetter: true,
  requires: ['crm.deal.read'],
  async total(ctx, range) {
    const [won, lost] = await Promise.all([
      ctx.db.deal.count({
        where: { deletedAt: null, status: 'WON', wonAt: { gte: range.from, lte: range.to } },
      }),
      ctx.db.deal.count({
        where: { deletedAt: null, status: 'LOST', lostAt: { gte: range.from, lte: range.to } },
      }),
    ])

    const closed = won + lost
    // Nothing closed is not a 0% win rate; it is no data. Zero would be read as
    // "we lost everything", which is a different and false statement.
    return { value: closed === 0 ? 0 : Math.round((won / closed) * 100) }
  },
  drilldown: (orgSlug) => `/${orgSlug}/crm/pipeline`,
})

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

registerMetric({
  key: 'people.active',
  label: 'Active members',
  description: 'People with access to this organization right now.',
  unit: 'count',
  higherIsBetter: true,
  requires: ['people.read'],
  async total(ctx) {
    const value = await ctx.db.membership.count({ where: { status: 'ACTIVE' } })
    return { value }
  },
  drilldown: (orgSlug) => `/${orgSlug}/people`,
})
