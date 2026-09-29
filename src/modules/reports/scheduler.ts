import { runDueReports } from './service'

/**
 * The scheduled-report entry point.
 *
 * A thin boundary so the cron route does not import the service directly — the
 * same layering rule every other caller follows. `modules/workflows/engine.ts`
 * and `modules/notifications/dispatch.ts` exist for the same reason.
 */
export { runDueReports }

export const sweepReports = () => runDueReports()
