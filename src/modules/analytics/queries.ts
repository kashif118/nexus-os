import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for analytics Server Components. */

export const getAnalytics = (ctx: Ctx, options?: { period?: string; orgSlug?: string }) =>
  service.getAnalytics(ctx, options)

export const availableMetrics = (ctx: Ctx) => service.availableMetrics(ctx)
