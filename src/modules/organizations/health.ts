import { getSystemDb } from '@/lib/db'

/**
 * The database liveness check, behind a boundary.
 *
 * A route handler must not reach for the database client directly — that rule
 * is enforced by the layering lint, and it is the reason this two-line module
 * exists rather than the query sitting in the route.
 *
 * `SELECT 1` and nothing more. A health check that reads a real table couples
 * uptime to that table's health, and a health check that is expensive is a
 * denial-of-service amplifier: it is unauthenticated and called on a timer.
 */
export async function checkDatabase(): Promise<void> {
  await getSystemDb().$queryRaw`SELECT 1`
}
