import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for notification Server Components. */

export const listNotifications = (
  ctx: Ctx,
  options?: { unreadOnly?: boolean; limit?: number; cursor?: string },
) => service.listNotifications(ctx, options)

export const countUnread = (ctx: Ctx) => service.countUnread(ctx)
export const listPreferences = (ctx: Ctx) => service.listPreferences(ctx)
export const preferenceGroups = () => service.preferenceGroups()
export const listActivity = (
  ctx: Ctx,
  filters?: { entityType?: string | undefined; entityId?: string | undefined; limit?: number },
) => service.listActivity(ctx, filters)
