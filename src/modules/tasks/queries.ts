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
