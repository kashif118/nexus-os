import { z } from 'zod'

import type { Permission } from '@/kernel/authz/catalogue'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { getAnalytics } from '@/modules/analytics/queries'
import { resolveRange, type PeriodKey } from '@/modules/analytics/periods'

/**
 * Report templates.
 *
 * A template is a function from parameters to TABLES OF FACTS. It computes
 * from the source rows through the same services and queries the screens use,
 * so a report can never show a figure the viewer could not see by navigating
 * there — and can never show one that disagrees with the screen.
 *
 * Deliberately no narrative text in any of these. A model may later be asked to
 * describe a report; the numbers it would describe are computed here, and the
 * model may not alter them. Keeping the two apart is what makes that safe.
 */

export interface ReportColumn {
  key: string
  label: string
  align?: 'left' | 'right'
}

export interface ReportSection {
  title: string
  /** One line explaining what the section counts, in the report itself. */
  note?: string
  columns: ReportColumn[]
  rows: Array<Record<string, string>>
}

export interface ReportOutput {
  title: string
  subtitle: string
  generatedAt: Date
  sections: ReportSection[]
}

export interface ReportTemplate<TParams = Record<string, unknown>> {
  key: string
  name: string
  description: string
  requires: Permission[]
  parameters: z.ZodType<TParams>
  /** Field descriptors, so the parameter form is generated rather than written. */
  fields: Array<{
    name: string
    label: string
    type: 'period' | 'text'
    options?: ReadonlyArray<{ value: string; label: string }>
  }>
  build(ctx: Ctx, params: TParams): Promise<ReportOutput>
}

const TEMPLATES = new Map<string, ReportTemplate<never>>()

export function registerTemplate<TParams>(template: ReportTemplate<TParams>): void {
  if (TEMPLATES.has(template.key)) throw new Error(`Duplicate report template: ${template.key}`)
  TEMPLATES.set(template.key, template as ReportTemplate<never>)
}

export const getTemplate = (key: string): ReportTemplate<never> | undefined => TEMPLATES.get(key)
export const listTemplates = (): Array<ReportTemplate<never>> => [...TEMPLATES.values()]

export const templatesFor = (ctx: Ctx): Array<ReportTemplate<never>> =>
  listTemplates().filter((template) => template.requires.every((permission) => ctx.can(permission)))

/* -------------------------------------------------------------------------- */

const PERIOD_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'ytd', label: 'Year to date' },
] as const

const periodParam = z.object({
  period: z.enum(['7d', '30d', '90d', '12m', 'ytd']).default('30d'),
})

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10)

/* -------------------------------------------------------------------------- */
/* Executive summary                                                           */
/* -------------------------------------------------------------------------- */

registerTemplate({
  key: 'executive-summary',
  name: 'Executive summary',
  description:
    'Every metric you have access to for the period, with its change against the preceding window.',
  requires: ['report.generate'],
  parameters: periodParam,
  fields: [{ name: 'period', label: 'Period', type: 'period', options: PERIOD_OPTIONS }],
  async build(ctx, params) {
    const analytics = await getAnalytics(ctx, { period: params.period })

    return {
      title: 'Executive summary',
      subtitle: `${analytics.rangeLabel} · ${dateOnly(analytics.from)} to ${dateOnly(analytics.to)} (UTC)`,
      generatedAt: new Date(),
      sections: [
        {
          title: 'Metrics',
          note: 'Each change compares the period against the preceding window of the same length. A blank change means there was no baseline to compare against.',
          columns: [
            { key: 'metric', label: 'Metric' },
            { key: 'value', label: 'Value', align: 'right' },
            { key: 'previous', label: 'Previous', align: 'right' },
            { key: 'change', label: 'Change', align: 'right' },
          ],
          rows: analytics.metrics.map((metric) => ({
            metric: metric.label,
            value:
              metric.unit === 'money' && metric.valueMinor !== null
                ? formatMoney(metric.valueMinor, analytics.currency)
                : metric.unit === 'percent'
                  ? `${Math.round(metric.value)}%`
                  : String(Math.round(metric.value)),
            previous:
              metric.unit === 'money'
                ? formatMoney(BigInt(Math.round(metric.previousValue * 100)), analytics.currency)
                : String(Math.round(metric.previousValue)),
            change: metric.changePercent === null ? '' : `${metric.changePercent}%`,
          })),
        },
      ],
    }
  },
})

/* -------------------------------------------------------------------------- */
/* Receivables ageing                                                          */
/* -------------------------------------------------------------------------- */

registerTemplate({
  key: 'receivables-ageing',
  name: 'Receivables ageing',
  description: 'Outstanding invoices grouped by how overdue they are.',
  requires: ['finance.invoice.read', 'report.generate'],
  parameters: z.object({}),
  fields: [],
  async build(ctx) {
    const invoices = await ctx.db.invoice.findMany({
      where: { deletedAt: null, status: { in: ['SENT', 'OVERDUE'] }, balanceMinor: { gt: 0 } },
      orderBy: { dueDate: 'asc' },
      select: {
        number: true,
        dueDate: true,
        balanceMinor: true,
        currency: true,
        company: { select: { name: true } },
      },
    })

    const now = Date.now()
    const bucketOf = (dueDate: Date): string => {
      const days = Math.floor((now - dueDate.getTime()) / 86_400_000)
      if (days < 0) return 'Not yet due'
      if (days <= 30) return '1–30 days'
      if (days <= 60) return '31–60 days'
      if (days <= 90) return '61–90 days'
      return 'Over 90 days'
    }

    const order = ['Not yet due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days']
    const totals = new Map<string, { count: number; minor: bigint }>()

    for (const invoice of invoices) {
      const key = bucketOf(invoice.dueDate)
      const current = totals.get(key) ?? { count: 0, minor: 0n }
      totals.set(key, { count: current.count + 1, minor: current.minor + invoice.balanceMinor })
    }

    const currency = invoices[0]?.currency ?? ctx.org.currency

    return {
      title: 'Receivables ageing',
      subtitle: `As at ${dateOnly(new Date())} (UTC)`,
      generatedAt: new Date(),
      sections: [
        {
          title: 'Summary',
          note: 'Outstanding balance, not the invoiced total. Age is measured from the due date.',
          columns: [
            { key: 'bucket', label: 'Age' },
            { key: 'count', label: 'Invoices', align: 'right' },
            { key: 'balance', label: 'Balance', align: 'right' },
          ],
          rows: order
            .filter((bucket) => totals.has(bucket))
            .map((bucket) => {
              const entry = totals.get(bucket)!
              return {
                bucket,
                count: String(entry.count),
                balance: formatMoney(entry.minor, currency),
              }
            }),
        },
        {
          title: 'Invoices',
          columns: [
            { key: 'number', label: 'Number' },
            { key: 'client', label: 'Client' },
            { key: 'due', label: 'Due' },
            { key: 'age', label: 'Age' },
            { key: 'balance', label: 'Balance', align: 'right' },
          ],
          rows: invoices.map((invoice) => ({
            number: invoice.number,
            client: invoice.company.name,
            due: dateOnly(invoice.dueDate),
            age: bucketOf(invoice.dueDate),
            balance: formatMoney(invoice.balanceMinor, invoice.currency),
          })),
        },
      ],
    }
  },
})

/* -------------------------------------------------------------------------- */
/* Project status                                                              */
/* -------------------------------------------------------------------------- */

registerTemplate({
  key: 'project-status',
  name: 'Project status',
  description: 'Every active project with its health, progress and open work.',
  requires: ['report.generate'],
  parameters: z.object({}),
  fields: [],
  async build(ctx) {
    const projects = await ctx.db.project.findMany({
      where: { deletedAt: null, status: { in: ['ACTIVE', 'PLANNING'] } },
      orderBy: [{ healthScore: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        status: true,
        healthStatus: true,
        healthScore: true,
        progressPercent: true,
        dueDate: true,
        manager: { select: { user: { select: { name: true } } } },
      },
    })

    const openCounts = await ctx.db.task.groupBy({
      by: ['projectId'],
      where: { deletedAt: null, status: { notIn: ['DONE', 'CANCELLED'] } },
      _count: { _all: true },
    })

    const openByProject = new Map(
      openCounts.map((row) => [row.projectId ?? '', row._count._all] as const),
    )

    return {
      title: 'Project status',
      subtitle: `As at ${dateOnly(new Date())} (UTC)`,
      generatedAt: new Date(),
      sections: [
        {
          title: 'Projects',
          note: 'Health is derived from overdue tasks, missed milestones, remaining time and budget. It is not set by hand.',
          columns: [
            { key: 'key', label: 'Key' },
            { key: 'name', label: 'Project' },
            { key: 'manager', label: 'Manager' },
            { key: 'health', label: 'Health' },
            { key: 'progress', label: 'Progress', align: 'right' },
            { key: 'open', label: 'Open tasks', align: 'right' },
            { key: 'due', label: 'Due' },
          ],
          rows: projects.map((project) => ({
            key: project.key,
            name: project.name,
            manager: project.manager?.user.name ?? '—',
            health: `${project.healthStatus} (${project.healthScore})`,
            progress: `${project.progressPercent}%`,
            open: String(openByProject.get(project.id) ?? 0),
            due: project.dueDate ? dateOnly(project.dueDate) : '—',
          })),
        },
      ],
    }
  },
})

/* -------------------------------------------------------------------------- */
/* Team workload                                                               */
/* -------------------------------------------------------------------------- */

registerTemplate({
  key: 'team-workload',
  name: 'Team workload',
  description: 'Open and overdue work per person.',
  requires: ['people.workload.view', 'report.generate'],
  parameters: z.object({}),
  fields: [],
  async build(ctx) {
    const members = await ctx.db.membership.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { user: { name: 'asc' } },
      select: { id: true, user: { select: { name: true } } },
    })

    const [open, overdue] = await Promise.all([
      ctx.db.task.groupBy({
        by: ['assigneeMembershipId'],
        where: { deletedAt: null, status: { notIn: ['DONE', 'CANCELLED'] } },
        _count: { _all: true },
      }),
      ctx.db.task.groupBy({
        by: ['assigneeMembershipId'],
        where: {
          deletedAt: null,
          status: { notIn: ['DONE', 'CANCELLED'] },
          dueDate: { lt: new Date() },
        },
        _count: { _all: true },
      }),
    ])

    const openBy = new Map(open.map((row) => [row.assigneeMembershipId ?? '', row._count._all]))
    const overdueBy = new Map(
      overdue.map((row) => [row.assigneeMembershipId ?? '', row._count._all]),
    )

    return {
      title: 'Team workload',
      subtitle: `As at ${dateOnly(new Date())} (UTC)`,
      generatedAt: new Date(),
      sections: [
        {
          title: 'People',
          note: 'Counts of tasks, which are not a measure of effort. Read alongside the estimates.',
          columns: [
            { key: 'name', label: 'Person' },
            { key: 'open', label: 'Open', align: 'right' },
            { key: 'overdue', label: 'Overdue', align: 'right' },
          ],
          rows: members.map((member) => ({
            name: member.user.name,
            open: String(openBy.get(member.id) ?? 0),
            overdue: String(overdueBy.get(member.id) ?? 0),
          })),
        },
      ],
    }
  },
})

/** Exported for the parameter form and for validation at save time. */
export const PERIOD_CHOICES = PERIOD_OPTIONS
export type ReportPeriod = PeriodKey
export { resolveRange }
