/**
 * Loads local database credentials for integration tests.
 *
 * Unit tests need none of this; integration tests skip themselves when
 * DATABASE_URL is absent, so a plain `npm test` still works on a machine with no
 * database.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

for (const file of ['.env.test.local', '.env.local']) {
  const path = resolve(process.cwd(), file)
  if (existsSync(path)) process.loadEnvFile(path)
}
