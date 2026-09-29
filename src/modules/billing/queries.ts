import type { Ctx } from '@/kernel/tenancy/ctx'

import { usageFor } from './entitlements'
import * as service from './service'

/** Read boundary for billing Server Components. */

export const getBillingOverview = (ctx: Ctx) => service.getBillingOverview(ctx)
export const getUsage = (ctx: Ctx) => usageFor(ctx)
