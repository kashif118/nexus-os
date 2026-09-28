import type { Ctx } from '@/kernel/tenancy/ctx'

import { resolveWidgets, visibleWidgets, type ResolvedWidget } from './registry'
import { loadWidgets, PENDING_MODULES } from './widgets'

/**
 * Read boundary for the Command Center.
 *
 * Loads the widget registry, filters it by permission, and resolves only what
 * this actor may see. A resolver for a widget the actor lacks never runs.
 */
export async function getDashboard(ctx: Ctx): Promise<{
  widgets: ResolvedWidget[]
  pending: typeof PENDING_MODULES
}> {
  await loadWidgets()
  const definitions = visibleWidgets(ctx)
  return { widgets: await resolveWidgets(ctx, definitions), pending: PENDING_MODULES }
}
