import { NextResponse } from 'next/server'

import { handleWebhook } from '@/modules/billing/webhook'

/**
 * The payment provider webhook.
 *
 * The RAW body is required: the signature covers the exact bytes sent, so
 * parsing it first and re-serialising would change them and every verification
 * would fail. That is why this reads `request.text()` and never `request.json()`.
 *
 * This is the only endpoint in the system that can move a subscription into a
 * paid state, and it does so only after the signature verifies.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')

  const result = await handleWebhook(rawBody, signature)
  return NextResponse.json(result.body, { status: result.status })
}
