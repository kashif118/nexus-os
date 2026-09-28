import { registerWidgets, type WidgetDefinition } from '../dashboard/registry'
import * as repository from './repository'

/** Task contributions to the Command Center. All scoped to what the actor can see. */
const scopeFor = (ctx: Parameters<WidgetDefinition['resolve']>[0]) =>
  ctx.can('project.read.any') ? ('all' as const) : ('own' as const)

export const TASK_WIDGETS: WidgetDefinition[] = [
  {
    id: 'tasks.mine',
    title: 'My open work',
    description: 'Tasks assigned to you that are not finished.',
    kind: 'stat',
    span: 3,
    module: 'tasks',
    requires: ['task.read'],
    resolve: async (ctx) => {
      const count = await repository.countMyOpenTasks(ctx)
      return {
        kind: 'stat',
        value: String(count),
        detail: count === 0 ? 'Nothing assigned' : 'assigned to you',
        href: `/${ctx.orgSlug}/tasks?mine=1`,
      }
    },
  },
  {
    id: 'tasks.overdue',
    title: 'Overdue work',
    description: 'Tasks past their due date and still open.',
    kind: 'stat',
    span: 3,
    module: 'tasks',
    requires: ['task.read'],
    resolve: async (ctx) => {
      const count = await repository.countOverdue(ctx, scopeFor(ctx))
      return {
        kind: 'stat',
        value: String(count),
        detail: count === 0 ? 'Nothing is late' : 'past the due date',
        href: `/${ctx.orgSlug}/tasks`,
        ...(count > 0
          ? { trend: { direction: 'up' as const, label: 'Needs attention', good: false } }
          : {}),
      }
    },
  },
  {
    id: 'tasks.completion',
    title: 'Task completion',
    description: 'Where work currently sits.',
    kind: 'breakdown',
    span: 6,
    module: 'tasks',
    requires: ['task.read'],
    resolve: async (ctx) => {
      const grouped = await repository.countTasksByStatus(ctx, scopeFor(ctx))
      const segments = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'].map((status) => ({
        label: status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' '),
        value: grouped.find((row) => row.status === status)?._count._all ?? 0,
      }))

      return {
        kind: 'breakdown',
        segments,
        total: segments.reduce((sum, segment) => sum + segment.value, 0),
        emptyLabel: 'No tasks yet.',
      }
    },
  },
  {
    id: 'tasks.upcoming',
    title: 'Your next tasks',
    description: 'Soonest first.',
    kind: 'list',
    span: 6,
    module: 'tasks',
    requires: ['task.read'],
    resolve: async (ctx) => {
      const tasks = await repository.listMyUpcoming(ctx, 5)
      return {
        kind: 'list',
        emptyLabel: 'Nothing assigned to you.',
        items: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          href: `/${ctx.orgSlug}/tasks/${task.id}`,
          meta: task.project?.key ? `${task.project.key}-${task.number}` : `#${task.number}`,
          badge: task.dueDate
            ? {
                label: task.dueDate.toISOString().slice(0, 10),
                tone: task.dueDate < new Date() ? ('destructive' as const) : ('neutral' as const),
              }
            : undefined,
        })),
      }
    },
  },
]

registerWidgets(TASK_WIDGETS)
