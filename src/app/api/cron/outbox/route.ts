import { NextResponse } from 'next/server'

import { getCronSecret } from '@/kernel/config/env'
import { log } from '@/kernel/observability/logger'
import { acquireCronLock } from '@/modules/notifications/cron-lock'
import { runDrain } from '@/modules/notifications/dispatch'
import { runDueReports } from '@/modules/reports/scheduler'
import { resumeDueRuns, runQueued } from '@/modules/workflows/engine'

/**
 * The outbox drain, as a scheduled endpoint.
 *
 * Events are normally drained right after the request that emitted them, via
 * `after()`. This endpoint is the safety net for the cases that misses: a
 * process that died mid-drain, a subscriber that failed and is due a retry, an
 * event emitted by a job rather than a request.
 *
 * It also moves workflow runs along — a run suspended at a delay or an approval
 * deadline has nothing else to wake it, so without a scheduled call those runs
 * would wait forever — and generates any report whose schedule is due.
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

/**
 * Vercel's scheduler issues a GET, not a POST.
 *
 * Both are accepted, and both require the secret. A GET that changes things is
 * not something to be pleased about, but the alternative is a cron entry that
 * silently 405s forever — and "the drain never ran" is not a failure anybody
 * notices until a week of notifications has not been sent.
 */
export async function GET(request: Request) {
  return POST(request)
}

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

  /*
   * Refuse to run on top of a run already in progress.
   *
   * Every individual operation below is already idempotent — outbox delivery by
   * `(event, subscriber)`, workflow steps by `(runId, nodeId)` — so an overlap
   * is safe rather than corrupting. It is still worth preventing: a sweep that
   * takes longer than the five-minute schedule would otherwise accumulate
   * concurrent invocations, each competing for the same connections, and the
   * symptom would be a pool exhausted by the thing meant to be draining it.
   *
   * A Postgres advisory lock rather than a row: it is released automatically
   * when the connection goes, so a killed invocation cannot wedge the schedule.
   */
  const lock = await acquireCronLock()

  if (!lock.acquired) {
    log.info('cron.outbox.skipped', { reason: 'already running' })
    return NextResponse.json({ skipped: true, reason: 'A sweep is already running.' })
  }

  const startedAt = Date.now()

  try {
    // Four sweeps, in order: deliver events, execute anything they queued, wake
    // runs whose delay or approval deadline has passed, and generate any report
    // whose schedule is due.
    const events = await runDrain(200)
    const queued = await runQueued(50)
    const resumed = await resumeDueRuns(50)
    const reports = await runDueReports()

    const summary = {
      events,
      workflowRuns: { started: queued.length, resumed: resumed.length },
      reports,
    }

    // Logged on every run, not only on failure: "the cron has not run since
    // Tuesday" is only answerable if a successful run says something.
    log.info('cron.outbox.completed', { ...summary, durationMs: Date.now() - startedAt })

    return NextResponse.json(summary)
  } catch (error) {
    log.error('cron.outbox.failed', { durationMs: Date.now() - startedAt, error })
    // 500 so the platform records a failed invocation rather than a silent one.
    return NextResponse.json({ error: 'The scheduled sweep failed.' }, { status: 500 })
  } finally {
    await lock.release()
  }
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
