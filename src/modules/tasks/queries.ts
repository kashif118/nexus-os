import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'

import type { TaskSort } from './schema'
import * as service from './service'

/** Read boundary for task Server Components. */

export const listTasks = (
  ctx: Ctx,
  params: ListParams<TaskSort>,
  filters?: {
    projectId?: string | undefined
    status?: string | undefined
    assigneeMembershipId?: string | undefined
    mine?: boolean
    overdue?: boolean
  },
) => service.listTasks(ctx, params, filters)

export const getBoard = (ctx: Ctx, filters?: { projectId?: string | undefined; mine?: boolean }) =>
  service.getBoard(ctx, filters)

export const getTask = (ctx: Ctx, id: string) => service.getTask(ctx, id)

export const getTaskFormOptions = (ctx: Ctx) => service.getTaskFormOptions(ctx)

export const listLabels = (ctx: Ctx) => service.listLabels(ctx)

/**
 * Write entry points for the AI tool layer.
 *
 * Exposed through this boundary rather than letting a tool import the service,
 * for the same reason a page does: the layering rule holds for every caller,
 * and the service is still the one place that checks authorization.
 */
export const createTaskForAgent = (
  ctx: Ctx,
  input: {
    title: string
    description?: string | undefined
    assigneeMembershipId?: string | undefined
    priority?: string | undefined
    projectId?: string | undefined
    dueDate?: Date | undefined
  },
) =>
  service.createTask(
    ctx,
    {
      title: input.title,
      description: input.description,
      assigneeMembershipId: input.assigneeMembershipId,
      projectId: input.projectId,
      status: 'TODO',
      priority: (input.priority ?? 'MEDIUM') as never,
      dueDate: input.dueDate,
    },
    { ip: null, userAgent: 'ai-agent' },
  )

export const addCommentForAgent = (
  ctx: Ctx,
  input: { taskId: string; body: string },
  meta: { ip: string | null; userAgent: string | null },
) => service.addComment(ctx, input, meta)
