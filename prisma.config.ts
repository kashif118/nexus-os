import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineConfig, env } from 'prisma/config'

/**
 * Prisma CLI configuration (Prisma 7 replaced the `package.json#prisma` block
 * and the implicit schema location with this file).
 *
 * `schema` points at a folder: model definitions are split per domain
 * (docs/PLATFORM.md §F) so a 78-table schema stays navigable.
 *
 * The connection string is supplied here rather than in the schema's datasource
 * block because migrations must use the DIRECT (unpooled) connection — running
 * DDL through a transaction-mode pooler such as PgBouncer or the Neon pooler is
 * unreliable (docs/OPERATIONS.md §P.2). Application runtime uses the pooled
 * DATABASE_URL instead.
 */

// Prisma 7 dropped automatic .env loading, so the CLI needs it done explicitly.
// Values already present in the real environment (CI, Vercel) always win.
for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file)
  if (existsSync(path)) {
    process.loadEnvFile(path)
  }
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DIRECT_DATABASE_URL'),
  },
})
