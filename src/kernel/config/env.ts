/**
 * Validated environment configuration — the ONLY module permitted to read
 * `process.env` (enforced by `no-restricted-properties` in eslint.config.mjs).
 *
 * See docs/OPERATIONS.md §P.4. Rules:
 *  - the schema is the source of truth; `.env.example` is checked against it in CI
 *  - server variables are never bundled into client code
 *  - a missing or malformed required variable fails the boot, loudly
 *
 * Phase 01 declares only the variables the foundation actually uses. Variables
 * for auth, AI, storage, email and payments are added by the phase that
 * introduces them, so a developer is never asked for a secret nothing reads yet.
 */
import { z } from 'zod'

/** Variables available on the server only. */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Pooled connection string used at runtime (PgBouncer / Neon pooler).
   * Optional in Phase 01: no code opens a connection yet, so requiring it would
   * block `npm run dev` for no reason. Phase 02 makes it required.
   */
  DATABASE_URL: z.url().optional(),

  /** Direct (unpooled) connection string — migrations only. */
  DIRECT_DATABASE_URL: z.url().optional(),
})

/** Variables exposed to the browser. Must be `NEXT_PUBLIC_` prefixed. */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('NEXUS OS'),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>
export type ClientEnv = z.infer<typeof clientEnvSchema>

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

/**
 * Client values must be referenced as literal `process.env.NEXT_PUBLIC_*`
 * property accesses so that Next.js can statically inline them at build time.
 * Destructuring or dynamic access would produce `undefined` in the browser.
 */
const rawClientEnv = {
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
}

function parseClientEnv(): ClientEnv {
  const parsed = clientEnvSchema.safeParse(rawClientEnv)
  if (!parsed.success) {
    throw new Error(
      `Invalid public environment variables:\n${formatIssues(parsed.error.issues)}\n` +
        'Check .env.example and your .env.local file.',
    )
  }
  return parsed.data
}

function parseServerEnv(): ServerEnv {
  const parsed = serverEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment variables:\n${formatIssues(parsed.error.issues)}\n` +
        'Check .env.example and your .env.local file.',
    )
  }
  return parsed.data
}

export const clientEnv: ClientEnv = parseClientEnv()

let cachedServerEnv: ServerEnv | undefined

/**
 * Server-side configuration. Throws if called from the browser so a server
 * secret can never be read from client code by accident.
 */
export function getServerEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('getServerEnv() was called in the browser. Use clientEnv instead.')
  }
  cachedServerEnv ??= parseServerEnv()
  return cachedServerEnv
}

/** Convenience flags derived from configuration. */
export const isProduction = process.env.NODE_ENV === 'production'
export const isTest = process.env.NODE_ENV === 'test'
