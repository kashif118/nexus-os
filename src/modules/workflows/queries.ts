import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for workflow Server Components. */

export const listWorkflows = (ctx: Ctx) => service.listWorkflows(ctx)
export const getWorkflow = (ctx: Ctx, id: string) => service.getWorkflow(ctx, id)
export const listRuns = (ctx: Ctx, workflowId?: string) => service.listRuns(ctx, workflowId)
export const getRun = (ctx: Ctx, id: string) => service.getRun(ctx, id)
export const listPendingApprovals = (ctx: Ctx) => service.listPendingApprovals(ctx)
export const availableTriggers = () => service.availableTriggers()
export const availableActions = () => service.availableActions()
