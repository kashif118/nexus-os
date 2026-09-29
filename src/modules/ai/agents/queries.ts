import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for agent Server Components. */

export const listAgentsWithConfig = (ctx: Ctx) => service.listAgentsWithConfig(ctx)
export const listRuns = (ctx: Ctx, agentKey?: string) => service.listRuns(ctx, agentKey)
export const getRun = (ctx: Ctx, id: string) => service.getRun(ctx, id)
export const listPendingProposals = (ctx: Ctx) => service.listPendingProposals(ctx)
