import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for AI Server Components. */

export const aiStatus = () => service.aiStatus()
export const listConversations = (ctx: Ctx) => service.listConversations(ctx)
export const getConversation = (ctx: Ctx, id: string) => service.getConversation(ctx, id)
export const listInsights = (ctx: Ctx) => service.listInsights(ctx)
export const getUsage = (ctx: Ctx) => service.getUsage(ctx)
