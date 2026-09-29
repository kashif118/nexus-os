import { NextResponse } from 'next/server'

import { isAppError } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'
import { exportFileName, toCsv } from '@/modules/reports/export'
import { generate } from '@/modules/reports/queries'

/**
 * Export a report as CSV.
 *
 * The report is REGENERATED for this request with the caller's own context, so
 * an export can never contain a figure the caller could not see on screen — and
 * a link shared with a colleague shows them their own version, not a snapshot
 * of somebody else's permissions.
 */
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgSlug: string; reportId: string }> },
) {
  void request
  const { orgSlug, reportId } = await params

  try {
    const ctx = await requireCtx(orgSlug)
    ctx.require('report.export')

    const report = await generate(ctx, reportId)
    const csv = toCsv(report)

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFileName(report, 'csv')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store, max-age=0',
      },
    })
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === 'UNAUTHENTICATED') {
        return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
      }
      if (error.code === 'FORBIDDEN') {
        return NextResponse.json({ error: 'You cannot export reports.' }, { status: 403 })
      }
      return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }

    console.error('[reports] export failed', error)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
