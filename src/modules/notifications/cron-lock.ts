import { getSystemDb } from '@/lib/db'

/**
 * A mutual exclusion lock for the scheduled sweep.
 *
 * Postgres advisory locks rather than a row in a table, for one reason that
 * matters more than the others: an advisory lock is tied to the SESSION, so it
 * is released automatically when the connection closes. A serverless invocation
 * that is killed mid-sweep therefore cannot leave the schedule permanently
 * wedged — which is exactly what a `locked_until` column does when the process
 * holding it never comes back to clear it.
 *
 * The trade is that the lock does not survive a connection drop mid-work, so
 * two sweeps can briefly overlap in that case. Everything they do is idempotent,
 * so an overlap costs duplicate effort rather than duplicate effects.
 *
 * The key is an arbitrary constant. It only has to be stable and not collide
 * with another advisory lock in the same database.
 */
const CRON_LOCK_KEY = 4_192_837_465

export interface CronLock {
  acquired: boolean
  release(): Promise<void>
}

export async function acquireCronLock(): Promise<CronLock> {
  const db = getSystemDb()

  const rows = await db.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${CRON_LOCK_KEY}::bigint) AS locked
  `

  const acquired = rows[0]?.locked === true

  return {
    acquired,
    async release() {
      if (!acquired) return
      // Failure to release is not worth failing the request over: the lock goes
      // when the connection does.
      await db.$queryRaw`SELECT pg_advisory_unlock(${CRON_LOCK_KEY}::bigint)`.catch(() => undefined)
    },
  }
}
