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
   *
   * Optional in the schema, and required in practice: `getDatabaseUrl()` throws
   * if it is absent. The distinction is deliberate — `next build` does not open
   * a connection, and a build that cannot run without a live database is a
   * build that cannot run in CI. The failure therefore happens at first use,
   * with a message that says which variable is missing.
   */
  DATABASE_URL: z.url().optional(),

  /** Direct (unpooled) connection string — migrations only. */
  DIRECT_DATABASE_URL: z.url().optional(),

  /**
   * Document storage (Phase 12).
   *
   * `local` writes to a gitignored directory and is for development only — a
   * serverless host has an ephemeral filesystem, so a production deployment
   * must set `s3`. The S3 variables are required only when that driver is
   * selected, which is why the object is refined rather than each field being
   * marked required.
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().min(1).default('.storage'),
  STORAGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(200 * 1024 * 1024)
    .optional(),

  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Shared secret for scheduled endpoints (Phase 13).
   *
   * Absent means scheduled endpoints refuse every request. That is the correct
   * default: an open endpoint that drains a queue is a denial of service handed
   * to anyone who finds the URL.
   */
  CRON_SECRET: z.string().min(24).optional(),

  /**
   * AI provider (Phase 15).
   *
   * Absent means no assistant. That is a supported state, not a broken one:
   * the insight engine, usage reporting and conversation history all work
   * without a model, and the UI says plainly that generation is unavailable.
   * Inventing a key to make a demo look complete would be worse than useless.
   */
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  ANTHROPIC_BASE_URL: z.url().optional(),
  /** Hard monthly ceiling in micros of USD. Default: 50 USD. */
  AI_MONTHLY_BUDGET_MICROS: z.coerce.number().int().positive().default(50_000_000),

  /**
   * Billing (Phase 20).
   *
   * `none` is a supported state, not a broken one: the application simply does
   * not take payments, plan limits still apply, and an owner sets the plan by
   * hand where billing is handled elsewhere. Nothing marks a subscription paid
   * without a verified provider event.
   */
  BILLING_PROVIDER: z.enum(['none', 'stripe']).default('none'),
  STRIPE_SECRET_KEY: z.string().min(10).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(10).optional(),
  STRIPE_PRICE_TEAM: z.string().min(1).optional(),
  STRIPE_PRICE_BUSINESS: z.string().min(1).optional(),
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

/**
 * The pooled runtime connection string.
 *
 * Kept out of module scope deliberately: `src/lib/db.ts` calls this only when a
 * client is actually constructed, so a build without database credentials still
 * succeeds while a request without them fails with a clear message.
 */
export function getDatabaseUrl(): string {
  const url = getServerEnv().DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not configured. Copy .env.example to .env.local and set a PostgreSQL connection string.',
    )
  }
  return url
}

/**
 * The scheduled-task secret, or null when none is configured.
 *
 * Returned rather than thrown so a development machine can run without one; the
 * endpoint itself refuses to work when it is absent.
 */
export function getCronSecret(): string | null {
  return getServerEnv().CRON_SECRET ?? null
}

/** Billing settings. `provider: 'none'` means the app takes no payments. */
export interface BillingConfig {
  provider: 'none' | 'stripe'
  stripe: {
    secretKey: string
    webhookSecret: string
    prices: Record<string, string>
  } | null
}

/**
 * Billing configuration.
 *
 * Selecting `stripe` without the keys throws, loudly, rather than falling back
 * to "no billing" — a deployment that believes it is charging and is not is
 * worse than one that knows it is not configured.
 */
export function getBillingConfig(): BillingConfig {
  const env = getServerEnv()

  if (env.BILLING_PROVIDER !== 'stripe') {
    return { provider: 'none', stripe: null }
  }

  const missing = (
    [
      ['STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY],
      ['STRIPE_WEBHOOK_SECRET', env.STRIPE_WEBHOOK_SECRET],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(
      `BILLING_PROVIDER=stripe requires: ${missing.join(', ')}. See .env.example and docs/OPERATIONS.md §P.4.`,
    )
  }

  const prices: Record<string, string> = {}
  if (env.STRIPE_PRICE_TEAM) prices.team = env.STRIPE_PRICE_TEAM
  if (env.STRIPE_PRICE_BUSINESS) prices.business = env.STRIPE_PRICE_BUSINESS

  return {
    provider: 'stripe',
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY!,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
      prices,
    },
  }
}

/** AI settings. `apiKey` null means generation is unavailable. */
export interface AiConfig {
  apiKey: string | null
  baseUrl: string | undefined
  monthlyBudgetMicros: number
}

export function getAiConfig(): AiConfig {
  const env = getServerEnv()
  return {
    apiKey: env.ANTHROPIC_API_KEY ?? null,
    baseUrl: env.ANTHROPIC_BASE_URL,
    monthlyBudgetMicros: env.AI_MONTHLY_BUDGET_MICROS,
  }
}

/** Resolved storage configuration, validated at the point of use. */
export type StorageConfig =
  | { driver: 'local'; localDir: string; maxUploadBytes: number | undefined }
  | {
      driver: 's3'
      maxUploadBytes: number | undefined
      s3: {
        endpoint: string
        region: string
        bucket: string
        accessKeyId: string
        secretAccessKey: string
        forcePathStyle: boolean
      }
    }

/**
 * Storage settings for the selected driver.
 *
 * The S3 variables are checked here rather than in the schema so that a
 * development machine is never asked for credentials it does not use — but
 * selecting `s3` without them fails loudly at the first upload rather than
 * silently writing nowhere. The secret is returned to the driver and nowhere
 * else; it is never logged and never crosses to the client.
 */
export function getStorageConfig(): StorageConfig {
  const env = getServerEnv()
  const maxUploadBytes = env.STORAGE_MAX_UPLOAD_BYTES

  if (env.STORAGE_DRIVER !== 's3') {
    return { driver: 'local', localDir: env.STORAGE_LOCAL_DIR, maxUploadBytes }
  }

  const missing = (
    [
      ['S3_ENDPOINT', env.S3_ENDPOINT],
      ['S3_REGION', env.S3_REGION],
      ['S3_BUCKET', env.S3_BUCKET],
      ['S3_ACCESS_KEY_ID', env.S3_ACCESS_KEY_ID],
      ['S3_SECRET_ACCESS_KEY', env.S3_SECRET_ACCESS_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(
      `STORAGE_DRIVER=s3 requires: ${missing.join(', ')}. See .env.example and docs/OPERATIONS.md §P.4.`,
    )
  }

  return {
    driver: 's3',
    maxUploadBytes,
    s3: {
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION!,
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
  }
}
