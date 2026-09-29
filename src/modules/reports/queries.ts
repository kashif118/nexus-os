import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for report Server Components. */

export const availableTemplates = (ctx: Ctx) => service.availableTemplates(ctx)
export const listReports = (ctx: Ctx) => service.listReports(ctx)
export const generate = (ctx: Ctx, id: string) => service.generate(ctx, id)
export const preview = (ctx: Ctx, template: string, params: Record<string, unknown>) =>
  service.preview(ctx, template, params)
