/**
 * The production preflight.
 *
 * `npm run check:env` proves `.env.example` matches the schema. That is a
 * different question from "is this configuration fit to serve real users", and
 * the engineering report exposed the gap: three variables documented as
 * OPTIONAL are, on a serverless deployment, required for the product to work at
 * all. Each fails silently rather than loudly, which is the worst way to fail:
 *
 *   - no email transport  → sign-ups are accepted and every one is stranded,
 *                           because the verification link goes to a log file
 *   - no CRON_SECRET      → no outbox drains, so notifications never arrive;
 *                           no workflow resumption, so every delay and approval
 *                           hangs forever; no scheduled reports
 *   - local file storage  → documents are written to an ephemeral filesystem
 *                           and disappear between invocations
 *
 * This script answers the real question. It reads configuration only — it opens
 * no connection, sends no request, and needs no credentials, so it is safe to
 * run anywhere including CI.
 *
 *   npm run check:production
 *
 * Exit code 1 if any BLOCKER is present. Warnings do not fail the run.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file)
  if (existsSync(path)) process.loadEnvFile(path)
}

type Severity = 'blocker' | 'warning' | 'ok'

interface Check {
  name: string
  severity: Severity
  detail: string
}

async function main() {
  const { getServerEnv } = await import('../src/kernel/config/env')

  let env: ReturnType<typeof getServerEnv>
  try {
    env = getServerEnv()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const checks: Check[] = []

  const add = (name: string, severity: Severity, detail: string) =>
    checks.push({ name, severity, detail })

  /* ------------------------------ blockers ------------------------------- */

  if (!env.DATABASE_URL) {
    add('Database', 'blocker', 'DATABASE_URL is not set. Nothing works without it.')
  } else if (/localhost|127\.0\.0\.1/.test(env.DATABASE_URL)) {
    add(
      'Database',
      'warning',
      'DATABASE_URL points at localhost. Correct locally, wrong in production.',
    )
  } else {
    add('Database', 'ok', 'DATABASE_URL is set.')
  }

  if (!env.DIRECT_DATABASE_URL) {
    add(
      'Migrations',
      'warning',
      'DIRECT_DATABASE_URL is not set. `prisma migrate deploy` through a transaction pooler is unreliable.',
    )
  } else {
    add('Migrations', 'ok', 'DIRECT_DATABASE_URL is set.')
  }

  if (env.EMAIL_PROVIDER === 'console') {
    add(
      'Email',
      'blocker',
      'EMAIL_PROVIDER=console prints verification and reset links to the server log. ' +
        'Every new account would be stranded. Set EMAIL_PROVIDER=smtp or resend, plus EMAIL_FROM.',
    )
  } else {
    add('Email', 'ok', `EMAIL_PROVIDER=${env.EMAIL_PROVIDER}.`)
  }

  if (env.STORAGE_DRIVER === 'local') {
    add(
      'Document storage',
      'blocker',
      'STORAGE_DRIVER=local writes to the local filesystem, which is ephemeral on a serverless host. ' +
        'Uploaded documents would vanish. Set STORAGE_DRIVER=s3 with S3_* credentials.',
    )
  } else {
    add('Document storage', 'ok', 'STORAGE_DRIVER=s3.')
  }

  if (!env.CRON_SECRET) {
    add(
      'Scheduled work',
      'blocker',
      'CRON_SECRET is not set, so /api/cron/outbox answers 503. No notification delivery, ' +
        'no workflow resumption past a delay or approval, and no scheduled reports. Fails silently.',
    )
  } else {
    add('Scheduled work', 'ok', 'CRON_SECRET is set.')
  }

  if (!env.SENTRY_DSN) {
    add(
      'Error reporting',
      'blocker',
      'SENTRY_DSN is not set. Errors reach stdout only — no alerting, and no retention beyond ' +
        "the host's function logs.",
    )
  } else {
    add('Error reporting', 'ok', 'SENTRY_DSN is set.')
  }

  /* ------------------------------ warnings ------------------------------- */

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl || /localhost/.test(appUrl)) {
    add(
      'Public URL',
      'blocker',
      'NEXT_PUBLIC_APP_URL is unset or points at localhost. Every link in every email would be wrong.',
    )
  } else if (!appUrl.startsWith('https://')) {
    add('Public URL', 'blocker', 'NEXT_PUBLIC_APP_URL is not https. Session cookies require it.')
  } else {
    add('Public URL', 'ok', appUrl)
  }

  if (env.BILLING_PROVIDER === 'none') {
    add(
      'Billing',
      'warning',
      'BILLING_PROVIDER=none. Plan limits still apply and an owner sets the plan by hand. ' +
        'Correct for self-hosting; a gap if you intend to charge.',
    )
  } else if (!env.STRIPE_PRICE_TEAM && !env.STRIPE_PRICE_BUSINESS) {
    add(
      'Billing',
      'warning',
      'BILLING_PROVIDER=stripe but no price ids are configured, so no plan can be purchased.',
    )
  } else {
    add('Billing', 'ok', 'Stripe configured with at least one price.')
  }

  if (!env.ANTHROPIC_API_KEY) {
    add(
      'AI',
      'warning',
      'ANTHROPIC_API_KEY is not set. The assistant reports itself unavailable; insights, usage ' +
        'and history still work. A supported state, not a broken one.',
    )
  } else {
    add('AI', 'ok', 'An AI provider key is configured.')
  }

  /* ------------------------------- output -------------------------------- */

  const symbol: Record<Severity, string> = { blocker: 'BLOCKER', warning: 'warn   ', ok: 'ok     ' }
  const order: Severity[] = ['blocker', 'warning', 'ok']

  console.log('\nProduction readiness\n')

  for (const severity of order) {
    for (const check of checks.filter((entry) => entry.severity === severity)) {
      console.log(`  ${symbol[severity]}  ${check.name}`)
      if (severity !== 'ok') console.log(`           ${check.detail}\n`)
    }
  }

  const blockers = checks.filter((check) => check.severity === 'blocker')
  const warnings = checks.filter((check) => check.severity === 'warning')

  console.log(
    `\n  ${blockers.length} blocker(s), ${warnings.length} warning(s), ` +
      `${checks.length - blockers.length - warnings.length} ok.\n`,
  )

  if (blockers.length > 0) {
    console.error(
      'This configuration is not fit to serve real users. Each blocker above fails silently ' +
        'rather than loudly, which is why this check exists.\n',
    )
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
