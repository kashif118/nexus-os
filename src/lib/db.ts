import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { getDatabaseUrl, isProduction } from '@/kernel/config/env'

/**
 * Database access.
 *
 * Prisma 7 no longer reads the connection string from the schema — it requires a
 * driver adapter supplied at construction (docs/ROADMAP.md §U2). `pg` is used
 * here; swapping to the Neon serverless driver in production is a change to this
 * file alone.
 *
 * The client is created LAZILY so that importing this module does not require a
 * configured database. That keeps `next build` working without credentials while
 * still failing loudly at request time when the URL is missing.
 *
 * ### Tenancy
 * `getSystemDb()` returns an UNSCOPED client. Once organizations exist, the
 * org-scoped `getDb(ctx)` — whose client extension injects `organizationId` into
 * every query (docs/PLATFORM.md §H.3) — becomes the default, and `getSystemDb()`
 * is restricted to the narrow list of cross-tenant surfaces in §H.4. Today
 * authentication is exactly such a surface: resolving an email to a user is
 * necessarily a cross-tenant lookup.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getDatabaseUrl() })

  return new PrismaClient({
    adapter,
    log: isProduction ? ['error'] : ['error', 'warn'],
  })
}

/**
 * The unscoped client, cached on `globalThis` so that hot reloads in development
 * and warm serverless instances in production reuse one connection pool rather
 * than opening a new one per module evaluation.
 */
export function getSystemDb(): PrismaClient {
  globalForPrisma.prisma ??= createClient()
  return globalForPrisma.prisma
}

/**
 * Prisma-generated types are re-exported here so that `@prisma/client` has
 * exactly one import site in the codebase (enforced by `no-restricted-imports`).
 * That keeps the ORM swappable and, more importantly, keeps the org-scoping
 * client the only way to reach data once tenancy lands.
 */
export type { Prisma, UserStatus, VerificationPurpose, ActorType } from '@prisma/client'
