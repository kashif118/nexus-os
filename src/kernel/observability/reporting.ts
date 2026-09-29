import { getErrorReportingConfig, isProduction } from '@/kernel/config/env'
import { isRedactedField, REDACTION_MARKER } from '@/lib/ai/redact'

/**
 * Error reporting.
 *
 * Structured logs answer "what happened" for somebody already looking. This
 * answers "something happened" for somebody who is not — which is the gap
 * §20 of the engineering report names as the largest operational one.
 *
 * ## Why a port and a fetch adapter rather than `@sentry/nextjs`
 *
 * The same reasoning as the Anthropic adapter, and it is a trade with real
 * costs on both sides, so it is written down rather than asserted:
 *
 * - **What this gives up.** The SDK's automatic instrumentation: breadcrumbs,
 *   performance traces, source-map-resolved stack frames, and release health.
 *   Sentry groups issues by stack frame, and an envelope without frames groups
 *   by exception type and message instead — coarser, and occasionally wrong.
 * - **What it buys.** No build-time instrumentation hooks, no vendor types
 *   reaching the application, no client bundle cost (the browser sends to our
 *   own route, not to a third party), and a DSN that never leaves the server.
 *
 * If frame-level grouping and source maps become necessary, replacing this file
 * with the SDK is a contained change: everything above it calls `report()`.
 *
 * ## What is never sent
 *
 * Field names are filtered through the **same** redaction list the AI layer
 * uses, and the context object is deliberately restricted to identifiers —
 * organization id, membership id, route, method. No email address, no name, no
 * request body, no headers, no cookies, no query string. An error report is a
 * copy of your production data sitting on somebody else's infrastructure, and
 * the useful half is the ids.
 */

export type ReportLevel = 'error' | 'warning'

export interface ReportContext {
  /** Stable dotted name, matching the logger's event name. */
  event: string
  level?: ReportLevel
  /** Identifiers only. Anything that names a person does not belong here. */
  tags?: Record<string, string | undefined>
  /** Additional structured detail, redacted by field name before sending. */
  extra?: Record<string, unknown>
}

export interface ErrorReporter {
  readonly id: string
  report(error: unknown, context: ReportContext): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

const MAX_STACK_CHARS = 8_000
const MAX_VALUE_CHARS = 1_000

/**
 * Scrub a flat context object.
 *
 * Deliberately shallow: a nested object in an error report is almost always a
 * request body or a database row, and neither should be leaving the process.
 * Anything that is not a primitive is described rather than serialised.
 */
export function safeExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(extra)) {
    if (isRedactedField(key)) {
      result[key] = REDACTION_MARKER
      continue
    }

    if (value === null || value === undefined) {
      result[key] = value
    } else if (typeof value === 'string') {
      result[key] = value.slice(0, MAX_VALUE_CHARS)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else if (typeof value === 'bigint') {
      result[key] = value.toString()
    } else {
      // Not serialised. A shape is enough to find the code; the contents are
      // whatever the request happened to contain.
      result[key] = `[${Array.isArray(value) ? 'array' : typeof value}]`
    }
  }

  return result
}

export interface SerialisedException {
  type: string
  value: string
  stack: string | undefined
}

export function serialiseException(error: unknown): SerialisedException {
  if (error instanceof Error) {
    return {
      type: error.name || 'Error',
      value: error.message.slice(0, MAX_VALUE_CHARS),
      stack: error.stack?.slice(0, MAX_STACK_CHARS),
    }
  }

  if (typeof error === 'string') {
    return { type: 'Error', value: error.slice(0, MAX_VALUE_CHARS), stack: undefined }
  }

  return { type: 'NonError', value: `[${typeof error}]`, stack: undefined }
}

/* -------------------------------------------------------------------------- */
/* Sentry                                                                      */
/* -------------------------------------------------------------------------- */

export interface ParsedDsn {
  publicKey: string
  host: string
  projectId: string
  envelopeUrl: string
}

/**
 * Parse a Sentry DSN.
 *
 * Shape: `https://<publicKey>@<host>/<projectId>`. The public key is not a
 * secret in Sentry's model — it identifies the project and authorises ingest
 * only — but it is kept server-side here anyway, because there is no reason for
 * the browser to talk to an ingest endpoint directly when it can post to ours.
 */
export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn)
    const publicKey = url.username
    const projectId = url.pathname.replace(/^\//, '').split('/').pop() ?? ''

    if (!publicKey || !projectId || !url.hostname) return null

    return {
      publicKey,
      host: url.host,
      projectId,
      envelopeUrl:
        `${url.protocol}//${url.host}/api/${projectId}/envelope/` +
        `?sentry_key=${encodeURIComponent(publicKey)}&sentry_version=7`,
    }
  } catch {
    return null
  }
}

interface EnvelopeInput {
  eventId: string
  timestamp: number
  exception: SerialisedException
  context: ReportContext
  environment: string
  release: string | undefined
  serverName: string | undefined
}

/**
 * Build a Sentry envelope.
 *
 * Three newline-delimited JSON objects: envelope header, item header, payload.
 * Separated out and exported so the shape can be tested without a network —
 * the same reasoning as the Stripe signature verifier.
 */
export function buildEnvelope(input: EnvelopeInput): string {
  const header = JSON.stringify({
    event_id: input.eventId,
    sent_at: new Date(input.timestamp).toISOString(),
  })

  const payload = {
    event_id: input.eventId,
    timestamp: input.timestamp / 1000,
    platform: 'node',
    level: input.context.level ?? 'error',
    environment: input.environment,
    ...(input.release ? { release: input.release } : {}),
    ...(input.serverName ? { server_name: input.serverName } : {}),
    logger: input.context.event,
    exception: {
      values: [
        {
          type: input.exception.type,
          value: input.exception.value,
        },
      ],
    },
    tags: {
      event: input.context.event,
      ...Object.fromEntries(
        Object.entries(input.context.tags ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    },
    extra: {
      ...safeExtra(input.context.extra ?? {}),
      // Carried as text rather than parsed frames: without the SDK there is no
      // frame parser and no source-map resolution, and a wrong frame list is
      // worse than an honest string. Documented at the top of this file.
      ...(input.exception.stack ? { stacktrace: input.exception.stack } : {}),
    },
  }

  const item = JSON.stringify({ type: 'event', content_type: 'application/json' })

  return `${header}\n${item}\n${JSON.stringify(payload)}\n`
}

const REPORT_TIMEOUT_MS = 4_000

export function createSentryReporter(options: {
  dsn: ParsedDsn
  environment: string
  release: string | undefined
  serverName: string | undefined
}): ErrorReporter {
  return {
    id: 'sentry',

    async report(error, context) {
      const envelope = buildEnvelope({
        eventId: randomEventId(),
        timestamp: Date.now(),
        exception: serialiseException(error),
        context,
        environment: options.environment,
        release: options.release,
        serverName: options.serverName,
      })

      // A reporting failure must never become the error the user sees, and must
      // never hold a request open. Bounded, and swallowed.
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS)

      try {
        await fetch(options.dsn.envelopeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-sentry-envelope' },
          body: envelope,
          signal: controller.signal,
        })
      } catch {
        // Deliberately silent. Logging here would recurse through the logger,
        // which is what calls this.
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/** 32 lowercase hex characters, as Sentry requires. */
function randomEventId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

let cached: ErrorReporter | null | undefined
let override: ErrorReporter | undefined

/**
 * The configured reporter, or null.
 *
 * Null is a supported state, not a broken one: with no DSN the application logs
 * to stdout exactly as before. What it is NOT is silent about the gap — the
 * production preflight (`npm run check:production`) reports it as missing.
 */
export function getErrorReporter(): ErrorReporter | null {
  if (override) return override
  if (cached !== undefined) return cached

  const config = getErrorReportingConfig()
  const dsn = config.dsn ? parseDsn(config.dsn) : null

  cached =
    dsn === null
      ? null
      : createSentryReporter({
          dsn,
          environment: config.environment ?? (isProduction ? 'production' : 'development'),
          release: config.release,
          serverName: config.serverName,
        })

  return cached
}

export const isErrorReportingConfigured = (): boolean => getErrorReporter() !== null

/** Test seam. */
export function setErrorReporter(reporter: ErrorReporter | undefined): void {
  override = reporter
  cached = undefined
}

/**
 * Report without waiting and without the possibility of throwing.
 *
 * Called from the logger, so it must be safe on every path: an exception here
 * would replace a real error with a reporting error, which is the worst
 * possible trade.
 */
export function reportError(error: unknown, context: ReportContext): void {
  const reporter = getErrorReporter()
  if (!reporter) return

  void reporter.report(error, context).catch(() => {})
}
