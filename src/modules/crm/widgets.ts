import { formatMoney } from '@/lib/money'

import { registerWidgets, type WidgetDefinition } from '../dashboard/registry'
import * as repository from './repository'

/**
 * CRM contributions to the Command Center.
 *
 * Every value is a real aggregate over this organization rows. Each widget
 * declares the permission it needs, so the resolver never runs for someone who
 * should not see pipeline value.
 */
export const CRM_WIDGETS: WidgetDefinition[] = [
  {
    id: 'crm.pipeline.value',
    title: 'Open pipeline',
    description: 'Total value of deals still in play.',
    kind: 'stat',
    span: 3,
    module: 'crm',
    requires: ['crm.deal.value.view'],
    resolve: async (ctx) => {
      const { total, count } = await repository.sumDealsByStatus(ctx, 'OPEN')
      return {
        kind: 'stat',
        value: formatMoney(total, ctx.org.currency, { compact: true }),
        detail: `${count} open deal${count === 1 ? '' : 's'}`,
        href: `/${ctx.orgSlug}/crm/pipeline`,
      }
    },
  },
  {
    id: 'crm.won.value',
    title: 'Won this quarter',
    description: 'Closed-won value since the start of the quarter.',
    kind: 'stat',
    span: 3,
    module: 'crm',
    requires: ['crm.deal.value.view'],
    resolve: async (ctx) => {
      const now = new Date()
      const quarterStart = new Date(
        Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1),
      )
      const { total, count } = await repository.sumDealsByStatus(ctx, 'WON', quarterStart)
      return {
        kind: 'stat',
        value: formatMoney(total, ctx.org.currency, { compact: true }),
        detail: `${count} deal${count === 1 ? '' : 's'} won`,
        href: `/${ctx.orgSlug}/crm/deals?status=WON`,
      }
    },
  },
  {
    id: 'crm.leads.open',
    title: 'Open leads',
    description: 'Leads not yet converted or disqualified.',
    kind: 'stat',
    span: 3,
    module: 'crm',
    requires: ['crm.lead.read'],
    resolve: async (ctx) => {
      const grouped = await repository.countLeadsByStatus(ctx)
      const open = grouped
        .filter(
          (row) => row.status === 'NEW' || row.status === 'CONTACTED' || row.status === 'QUALIFIED',
        )
        .reduce((sum, row) => sum + row._count._all, 0)
      const qualified = grouped.find((row) => row.status === 'QUALIFIED')?._count._all ?? 0

      return {
        kind: 'stat',
        value: String(open),
        detail: `${qualified} qualified`,
        href: `/${ctx.orgSlug}/crm/leads`,
      }
    },
  },
  {
    id: 'crm.activities.upcoming',
    title: 'Upcoming client activity',
    description: 'Calls, meetings and follow-ups that are still open.',
    kind: 'list',
    span: 6,
    module: 'crm',
    requires: ['crm.contact.read', 'crm.deal.read'],
    resolve: async (ctx) => {
      const activities = await repository.listUpcomingActivities(ctx, 5)
      return {
        kind: 'list',
        emptyLabel: 'Nothing scheduled.',
        items: activities.map((activity) => ({
          id: activity.id,
          title: activity.subject,
          meta: activity.dueAt
            ? `${activity.type.toLowerCase()} · due ${activity.dueAt.toISOString().slice(0, 10)}`
            : activity.type.toLowerCase(),
        })),
      }
    },
  },
]

registerWidgets(CRM_WIDGETS)
