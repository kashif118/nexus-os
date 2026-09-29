import { applyProviderEvent } from './service'
import { getPaymentProvider } from './provider'

/**
 * The webhook boundary.
 *
 * A thin file so the route handler does not import the service directly, in
 * keeping with the layering rule everything else follows.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const provider = getPaymentProvider()

  if (!provider) {
    // No provider configured means no webhooks are expected. Answering 404
    // rather than 200 makes a misconfigured endpoint visible in the provider's
    // own dashboard instead of silently succeeding.
    return { status: 404, body: { error: 'Not found.' } }
  }

  const event = provider.verifyWebhook(rawBody, signature)

  if (!event) {
    // An unverified payload is refused outright and NOTHING is recorded from
    // it. Without this check, anybody who found the URL could declare any
    // subscription active.
    return { status: 400, body: { error: 'Signature verification failed.' } }
  }

  try {
    const result = await applyProviderEvent(event)
    return { status: 200, body: { received: true, applied: result.applied } }
  } catch (error) {
    console.error('[billing] webhook failed', { type: event.type, error })
    // 500 so the provider retries; the event id makes the retry idempotent.
    return { status: 500, body: { error: 'Could not process the event.' } }
  }
}
