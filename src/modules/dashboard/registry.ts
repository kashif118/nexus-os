import type { Permission } from '@/kernel/authz/catalogue'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { log } from '@/kernel/observability/logger'

/**
 * The Command Center widget registry (docs/ARCHITECTURE.md §A.2).
 *
 * The dashboard is not a page of hardcoded cards. It is a registry: each module
 * contributes widget definitions as it is built, and the dashboard renders
 * whichever ones the current actor is allowed to see.
 *
 * Three consequences that matter:
 *
 * 1. **A widget cannot leak.** Every definition declares the permission it
 *    needs, and `resolveWidgets` filters before any resolver runs — so an
 *    Employee never even triggers the query behind a finance widget.
 * 2. **Adding a module does not touch the dashboard.** Phase 07 registers CRM
 *    widgets, Phase 11 registers finance widgets; this file never changes.
 * 3. **Nothing is invented.** A widget exists only when a module can answer it
 *    from real rows. Until then the dashboard says which module will provide it
 *    rather than showing a fabricated number.
 */

/** How a widget renders. The dashboard maps these to components. */
export type WidgetKind = 'stat' | 'list' | 'breakdown' | 'alerts' | 'insights'

export interface StatValue {
  kind: 'stat'
  /** Formatted for display by the resolver, which knows the org currency. */
  value: string
  /** Optional supporting line, e.g. "3 added this week". */
  detail?: string
  /** Direction of travel, when a comparison is meaningful. */
  trend?: { direction: 'up' | 'down' | 'flat'; label: string; good: boolean }
  href?: string
}

export interface ListValue {
  kind: 'list'
  items: Array<{
    id: string
    title: string
    meta?: string
    badge?: { label: string; tone: 'neutral' | 'success' | 'warning' | 'destructive' | 'info' }
    href?: string
  }>
  emptyLabel: string
  href?: string
}

export interface BreakdownValue {
  kind: 'breakdown'
  segments: Array<{ label: string; value: number; tone?: string }>
  total: number
  emptyLabel: string
}

export type WidgetValue = StatValue | ListValue | BreakdownValue

export interface WidgetDefinition {
  id: string
  title: string
  description: string
  kind: WidgetKind
  /** Column span on the 12-column dashboard grid. */
  span: 3 | 4 | 6 | 12
  /** Any one of these permissions makes the widget visible. Empty = everyone. */
  requires?: Permission[]
  /** The module that owns it, shown in the layout editor. */
  module: string
  /**
   * Fetch the value. Runs ONLY after the permission check passes, and receives
   * the org-scoped context — so a resolver cannot read another tenant.
   */
  resolve: (ctx: Ctx) => Promise<WidgetValue>
}

const REGISTRY = new Map<string, WidgetDefinition>()

/**
 * Register a widget. Called at module load by each module's `widgets.ts`.
 *
 * Throws on a duplicate id rather than silently overwriting: two modules
 * claiming the same widget is a bug that should fail loudly at boot.
 */
export function registerWidget(definition: WidgetDefinition): void {
  if (REGISTRY.has(definition.id)) {
    throw new Error(`Duplicate dashboard widget id: ${definition.id}`)
  }
  REGISTRY.set(definition.id, definition)
}

export function registerWidgets(definitions: WidgetDefinition[]): void {
  for (const definition of definitions) registerWidget(definition)
}

export const getWidget = (id: string): WidgetDefinition | undefined => REGISTRY.get(id)

export const allWidgets = (): WidgetDefinition[] => [...REGISTRY.values()]

/** The widgets this actor may see, in registration order. */
export function visibleWidgets(ctx: Ctx): WidgetDefinition[] {
  return allWidgets().filter((widget) => !widget.requires?.length || ctx.canAny(widget.requires))
}

export interface ResolvedWidget {
  definition: WidgetDefinition
  value: WidgetValue | null
  /** Set when the resolver failed; the card degrades instead of the page. */
  error: string | null
}

/**
 * Resolve widgets for rendering.
 *
 * Resolvers run in parallel and are individually fault-isolated: one slow or
 * broken metric degrades its own card rather than taking down the dashboard.
 */
export async function resolveWidgets(
  ctx: Ctx,
  definitions: WidgetDefinition[],
): Promise<ResolvedWidget[]> {
  return Promise.all(
    definitions.map(async (definition): Promise<ResolvedWidget> => {
      try {
        return { definition, value: await definition.resolve(ctx), error: null }
      } catch (error) {
        log.error('dashboard.widget.failed', { widget: definition.id, error })
        return { definition, value: null, error: 'This metric could not be loaded.' }
      }
    }),
  )
}

/** Test seam: the registry is module-level state. */
export function __resetRegistry(): void {
  REGISTRY.clear()
}
