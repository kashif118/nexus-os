import { registerWidgets, type WidgetDefinition } from './registry'
import { log } from '@/kernel/observability/logger'

/**
 * Widgets the platform itself can answer today.
 *
 * Deliberately short. A widget appears here only when a module can answer it
 * from real rows — the Command Center shows what is true, and names the module
 * that will supply the rest rather than displaying a fabricated number
 * (docs/ROADMAP.md, Phase 06).
 *
 * Modules register their own widgets from `modules/<module>/widgets.ts`, which
 * `loadWidgets()` imports.
 */

const PLATFORM_WIDGETS: WidgetDefinition[] = [
  {
    id: 'org.members',
    title: 'Team',
    description: 'People with access to this organization.',
    kind: 'stat',
    span: 3,
    module: 'organizations',
    resolve: async (ctx) => {
      const [active, pending] = await Promise.all([
        ctx.db.membership.count({ where: { status: 'ACTIVE' } }),
        ctx.db.invitation.count({
          where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ])

      return {
        kind: 'stat',
        value: String(active),
        detail:
          pending > 0
            ? `${pending} invitation${pending === 1 ? '' : 's'} pending`
            : 'No pending invitations',
        href: `/${ctx.orgSlug}/settings/members`,
      }
    },
  },
]

let loaded = false

/**
 * Import every module that registers widgets.
 *
 * Imports are dynamic and side-effecting: a module registers on import, so this
 * is the single place that decides which modules contribute to the dashboard.
 * Called once per process before the dashboard renders.
 */
export async function loadWidgets(): Promise<void> {
  if (loaded) return
  loaded = true

  registerWidgets(PLATFORM_WIDGETS)

  // Module widget files are added here by the phase that builds them.
  // Each import is wrapped so a module that fails to load degrades the
  // dashboard rather than breaking the page.
  const moduleLoaders: Array<() => Promise<unknown>> = [
    () => import('../crm/widgets'),
    () => import('../projects/widgets'),
    () => import('../tasks/widgets'),
    () => import('../finance/widgets'),
  ]

  await Promise.all(
    moduleLoaders.map(async (load) => {
      try {
        await load()
      } catch (error) {
        log.error('dashboard.widgets.load.failed', { error })
      }
    }),
  )
}

/**
 * Modules not yet built, named so the dashboard can say what is coming instead
 * of pretending to have it. Removed as each phase lands.
 */
export const PENDING_MODULES: ReadonlyArray<{ module: string; contributes: string }> = []
