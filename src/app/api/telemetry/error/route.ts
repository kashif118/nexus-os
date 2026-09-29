import { NextResponse } from 'next/server'
import { z } from 'zod'

import { reportError, isErrorReportingConfigured } from '@/kernel/observability/reporting'

/**
 * Browser error reports.
 *
 * The client posts here rather than to a third-party ingest endpoint directly.
 * Three things follow from that, and they are the reason for the extra hop:
 *
 * 1. **The DSN stays on the server.** Nothing about the reporting vendor appears
 *    in the client bundle, and the Content-Security-Policy does not need a
 *    `connect-src` exception for somebody else's domain.
 * 2. **The same redaction applies.** A browser report goes through exactly the
 *    filter a server report does, rather than whatever the vendor's SDK happens
 *    to scrub.
 * 3. **The shape is ours.** The payload below is all that is accepted; a field
 *    the application does not send cannot be smuggled into an alert.
 *
 * It is deliberately unauthenticated, because the errors most worth hearing
 * about happen on the sign-in page. That makes it abusable, so it is bounded on
 * every axis: body size, rate, field count and field length. The event name is
 * forced into a `client.` namespace so this endpoint cannot be used to forge a
 * report that looks like it came from the server.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 8 * 1024

const payloadSchema = z.object({
  /** Constrained, not free text: an alert must not be forgeable from a browser. */
  kind: z.enum(['error', 'unhandledrejection', 'boundary']),
  message: z.string().min(1).max(500),
  stack: z.string().max(4_000).optional(),
  /** The route where it happened. A path only — never the query string. */
  path: z
    .string()
    .max(200)
    .optional()
    .transform((value) => value?.split('?')[0]),
  /** Next's error digest, so a client report can be tied to a server log line. */
  digest: z.string().max(100).optional(),
})

/*
 * A fixed window per address, held in memory.
 *
 * Per-instance, and therefore approximate on a platform that runs several: an
 * attacker willing to spread requests across instances gets a multiple of this.
 * That is an accepted limit rather than an oversight — the alternative is a
 * shared store, which this deployment does not have, and an approximate bound
 * on an endpoint that only writes telemetry is worth more than no bound.
 */
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 20
const buckets = new Map<string, { count: number; resetAt: number }>()

function withinRate(key: string, now = Date.now()): boolean {
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })

    // Opportunistic sweep, so the map cannot grow without bound on a
    // long-running instance.
    if (buckets.size > 10_000) {
      for (const [entry, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(entry)
      }
    }

    return true
  }

  bucket.count += 1
  return bucket.count <= MAX_PER_WINDOW
}

export async function POST(request: Request): Promise<NextResponse> {
  // Nothing to do with a report that has nowhere to go, and answering 204
  // rather than an error keeps the client from retrying.
  if (!isErrorReportingConfigured()) {
    return new NextResponse(null, { status: 204 })
  }

  const address =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'

  if (!withinRate(address)) {
    return new NextResponse(null, { status: 429 })
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 })
  }

  let parsed: z.infer<typeof payloadSchema>
  try {
    const result = payloadSchema.safeParse(JSON.parse(raw))
    // A malformed report is discarded quietly. Telling a caller why would make
    // this a probe for the schema.
    if (!result.success) return new NextResponse(null, { status: 204 })
    parsed = result.data
  } catch {
    return new NextResponse(null, { status: 204 })
  }

  const error = new Error(parsed.message)
  error.name = `Client${parsed.kind === 'boundary' ? 'Boundary' : 'Error'}`
  if (parsed.stack) error.stack = parsed.stack

  reportError(error, {
    // Namespaced, so a browser can never produce a report that looks like one
    // from the server.
    event: `client.${parsed.kind}`,
    tags: {
      source: 'browser',
      ...(parsed.path ? { path: parsed.path } : {}),
      ...(parsed.digest ? { digest: parsed.digest } : {}),
    },
  })

  return new NextResponse(null, { status: 204 })
}
