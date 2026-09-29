import { NextResponse } from 'next/server'

import { getCronSecret } from '@/kernel/config/env'
import { runDrain } from '@/modules/notifications/dispatch'

/**
 * The outbox drain, as a scheduled endpoint.
 *
 * Events are normally drained right after the request that emitted them, via
 * `after()`. This endpoint is the safety net for the cases that misses: a
 * process that died mid-drain, a subscriber that failed and is due a retry, an
 * event emitted by a job rather than a request.
 *
 * Authentication is a shared secret in a header, compared in constant time.
 * It is NOT a session: a scheduler has no user, and giving one a session would
 * mean creating an account with permissions that nobody reviews.
 *
 * With no `CRON_SECRET` configured the route refuses everything rather than
 * running open — an unauthenticated endpoint that drains a queue is a denial of
 * service handed to the internet.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const secret = getCronSecret()

  if (!secret) {
    return NextResponse.json(
      { error: 'Scheduled tasks are not configured on this deployment.' },
      { status: 503 },
    )
  }

  const provided =
    request.headers.get('x-cron-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    ''

  if (!timingSafeEqual(provided, secret)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  const result = await runDrain(200)
  return NextResponse.json(result)
}

/**
 * Length-independent comparison.
 *
 * `node:crypto`'s `timingSafeEqual` throws on a length mismatch, which leaks
 * the length; hashing both sides first makes every comparison the same size.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false

  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)

  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return diff === 0
}
