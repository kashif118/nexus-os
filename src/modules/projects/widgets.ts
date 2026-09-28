import { registerWidgets, type WidgetDefinition } from '../dashboard/registry'
import * as repository from './repository'

/**
 * Project contributions to the Command Center.
 *
 * Each resolver respects project visibility: the scope is resolved from the same
 * permissions the list screen uses, so a member sees counts for the projects
 * they can actually open, not the whole portfolio.
 */
const scopeFor = (ctx: Parameters<WidgetDefinition['resolve']>[0]) =>
  ctx.can('project.read.any') ? ('all' as const) : ('own' as const)

export const PROJECT_WIDGETS: WidgetDefinition[] = [
  {
    id: 'projects.active',
    title: 'Active projects',
    description: 'Projects currently in flight.',
    kind: 'stat',
    span: 3,
    module: 'projects',
    requires: ['project.read.any', 'project.read.member'],
    resolve: async (ctx) => {
      const grouped = await repository.countProjectsByStatus(ctx, scopeFor(ctx))
      const active = grouped.find((row) => row.status === 'ACTIVE')?._count._all ?? 0
      const planning = grouped.find((row) => row.status === 'PLANNING')?._count._all ?? 0

      return {
        kind: 'stat',
        value: String(active),
        detail: planning > 0 ? `${planning} in planning` : 'Nothing in planning',
        href: `/${ctx.orgSlug}/projects?status=ACTIVE`,
      }
    },
  },
  {
    id: 'projects.health',
    title: 'Project health',
    description: 'How the live portfolio is tracking.',
    kind: 'breakdown',
    span: 3,
    module: 'projects',
    requires: ['project.read.any', 'project.read.member'],
    resolve: async (ctx) => {
      const grouped = await repository.countProjectsByHealth(ctx, scopeFor(ctx))
      const segments = ['HEALTHY', 'AT_RISK', 'CRITICAL'].map((status) => ({
        label: status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' '),
        value: grouped.find((row) => row.healthStatus === status)?._count._all ?? 0,
      }))

      return {
        kind: 'breakdown',
        segments,
        total: segments.reduce((sum, segment) => sum + segment.value, 0),
        emptyLabel: 'No live projects.',
      }
    },
  },
  {
    id: 'projects.at_risk',
    title: 'Needs attention',
    description: 'Projects scoring worst on health.',
    kind: 'list',
    span: 6,
    module: 'projects',
    requires: ['project.read.any', 'project.read.member'],
    resolve: async (ctx) => {
      const projects = await repository.listAtRiskProjects(ctx, scopeFor(ctx), 5)
      return {
        kind: 'list',
        emptyLabel: 'Everything is tracking well.',
        items: projects.map((project) => ({
          id: project.id,
          title: project.name,
          href: `/${ctx.orgSlug}/projects/${project.id}`,
          meta: project.dueDate
            ? `due ${project.dueDate.toISOString().slice(0, 10)}`
            : 'no deadline',
          badge: {
            label: `${project.healthScore}`,
            tone:
              project.healthStatus === 'CRITICAL' ? ('destructive' as const) : ('warning' as const),
          },
        })),
      }
    },
  },
  {
    id: 'projects.deadlines',
    title: 'Upcoming deadlines',
    description: 'The next projects due.',
    kind: 'list',
    span: 6,
    module: 'projects',
    requires: ['project.read.any', 'project.read.member'],
    resolve: async (ctx) => {
      const projects = await repository.listUpcomingDeadlines(ctx, scopeFor(ctx), 5)
      return {
        kind: 'list',
        emptyLabel: 'No deadlines set.',
        items: projects.map((project) => ({
          id: project.id,
          title: project.name,
          href: `/${ctx.orgSlug}/projects/${project.id}`,
          meta: `${project.progressPercent}% complete`,
          badge: project.dueDate
            ? { label: project.dueDate.toISOString().slice(0, 10), tone: 'neutral' as const }
            : undefined,
        })),
      }
    },
  },
]

registerWidgets(PROJECT_WIDGETS)
