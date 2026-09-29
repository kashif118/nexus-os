import { NextResponse } from 'next/server'

import { log } from '@/kernel/observability/logger'
import { checkDatabase } from '@/modules/organizations/health'

/**
 * The health check.
 *
 * What a load balancer, an uptime monitor and a deploy script all ask: is this
 * instance able to serve requests? The answer is only meaningful if it touches
 * the one dependency without which nothing works, so it runs a trivial query
 * rather than returning a constant `{ ok: true }` — which would report healthy
 * on an instance whose database credentials had expired.
 *
 * It is public, and therefore says nothing a stranger should not know: no
 * version, no hostname, no connection string, no error text. A failure is a
 * 503 and a boolean; the detail goes to the log, where the people who can act
 * on it are looking.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now()

  try {
    await checkDatabase()

    return NextResponse.json(
      { status: 'ok', checks: { database: 'ok' } },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    log.error('health.database.failed', { durationMs: Date.now() - startedAt, error })

    return NextResponse.json(
      { status: 'unhealthy', checks: { database: 'failed' } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
}
