import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for security Server Components. */

export const listSessions = (ctx: Ctx) => service.listSessions(ctx)
export const listMySessions = (ctx: Ctx) => service.listMySessions(ctx)
export const listLoginEvents = (ctx: Ctx) => service.listLoginEvents(ctx)
export const listAuditLog = (ctx: Ctx, filters?: { action?: string | undefined; limit?: number }) =>
  service.listAuditLog(ctx, filters)
export const auditActions = (ctx: Ctx) => service.auditActions(ctx)
export const listApiKeys = (ctx: Ctx) => service.listApiKeys(ctx)
export const getPolicy = (ctx: Ctx) => service.getPolicy(ctx)
