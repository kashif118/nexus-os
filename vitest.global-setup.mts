/**
 * Seed the authorization catalogue once, before any suite runs.
 *
 * Every integration suite needs the permission and role rows to exist, and each
 * one used to call `seedAuthorization()` in its own `beforeAll`. That is
 * idempotent but not free: it upserts 109 permissions and seven roles inside a
 * transaction, and six suites doing it at once against one database produced
 * "Unable to start a transaction in the given time" in whichever suite lost the
 * race — a failure that looks like a bug in the code under test and is not.
 *
 * Doing it here means it happens exactly once, before anything else, and the
 * suites simply read what is already there.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export async function setup(): Promise<void> {
  for (const file of ['.env.test.local', '.env.local']) {
    const path = resolve(process.cwd(), file)
    if (existsSync(path)) process.loadEnvFile(path)
  }

  if (!process.env.DATABASE_URL) return

  const { seedAuthorization } = await import('./src/kernel/authz/seed')
  const { getSystemDb } = await import('./src/lib/db')

  await seedAuthorization()
  await getSystemDb().$disconnect()
}
