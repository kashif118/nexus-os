import { createHmac, timingSafeEqual } from 'node:crypto'

import { getBillingConfig } from '@/kernel/config/env'

/**
 * The payment provider port.
 *
 * Deliberately small: create a checkout session, create a portal session,
 * verify a webhook. Everything else about a subscription's state comes FROM the
 * provider through webhooks, never from this application asserting it.
 *
 * NOT CONFIGURED IS A SUPPORTED STATE. With no keys, `getPaymentProvider()`
 * returns null, checkout is unavailable and says so, and no subscription state
 * changes. There is no code path anywhere in this module that marks a
 * subscription active because a redirect came back — a redirect is not a
 * payment, and treating it as one is how a product gives away paid features
 * and simultaneously tells a customer they paid when they did not.
 *
 * VERIFICATION NOTE: the Stripe adapter below has not been exercised against
 * the live API, because no credentials were available and inventing them was
 * not an option. The signature verification — the part that must be right, and
 * the part that can be tested without a network — is unit-tested against
 * constructed payloads. Recorded in docs/ROADMAP.md §U.
 */

export interface CheckoutSession {
  url: string
  providerSessionId: string
}

export interface PaymentProvider {
  readonly id: string

  createCheckout(input: {
    organizationId: string
    planKey: string
    customerEmail: string
    successUrl: string
    cancelUrl: string
    existingCustomerId: string | null
  }): Promise<CheckoutSession>

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>

  /** Verify and parse a webhook. Returns null when the signature is invalid. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): ProviderEvent | null
}

export interface ProviderEvent {
  id: string
  type: string
  data: Record<string, unknown>
  /**
   * The provider's own creation timestamp.
   *
   * Carried because webhook delivery is not ordered: without it there is no way
   * to tell a delayed retry from genuinely newer state, and the older payload
   * would win.
   */
  createdAt: Date | null
}

/* -------------------------------------------------------------------------- */
/* Stripe                                                                      */
/* -------------------------------------------------------------------------- */

const API_BASE = 'https://api.stripe.com/v1'

export interface StripeConfig {
  secretKey: string
  webhookSecret: string
  /** Price id per plan key, from the provider's dashboard. */
  prices: Record<string, string>
}

/**
 * How long to wait on the provider.
 *
 * Bounded because this call sits inside a user's request. Without a timeout a
 * hung connection holds a serverless invocation until the platform kills it,
 * and the user watches a spinner until then.
 */
const API_TIMEOUT_MS = 15_000

export function createStripeProvider(config: StripeConfig): PaymentProvider {
  const post = async (path: string, form: Record<string, string>, idempotencyKey?: string) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          /*
           * Stripe deduplicates by this key for 24 hours. Without it, a user
           * who double-clicks — or a retry after a timeout where the request
           * actually succeeded — creates a second checkout session, and a
           * second session against the same customer is a second subscription
           * waiting to happen.
           */
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `The payment provider did not respond within ${API_TIMEOUT_MS / 1000} seconds.`,
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
      // The key never appears in an error message that might be logged.
      const detail = (body.error?.message ?? '').replace(/sk_[A-Za-z0-9_]+/g, '[redacted]')
      throw new Error(`The payment provider returned ${response.status}. ${detail}`.trim())
    }

    return (await response.json()) as Record<string, unknown>
  }

  return {
    id: 'stripe',

    async createCheckout(input) {
      const price = config.prices[input.planKey]
      if (!price) {
        throw new Error(`No price is configured for the ${input.planKey} plan.`)
      }

      const session = await post(
        '/checkout/sessions',
        {
          mode: 'subscription',
          'line_items[0][price]': price,
          'line_items[0][quantity]': '1',
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          // The organization id travels with the session so the webhook can match
          // the resulting customer to a tenant without trusting a redirect.
          'metadata[organizationId]': input.organizationId,
          'subscription_data[metadata][organizationId]': input.organizationId,
          ...(input.existingCustomerId
            ? { customer: input.existingCustomerId }
            : { customer_email: input.customerEmail }),
        },
        // Stable per organization and plan, so a double click or a retried
        // request reuses the session rather than creating a second one. The
        // hour bucket lets a genuinely new attempt later on start fresh.
        `checkout:${input.organizationId}:${input.planKey}:${Math.floor(Date.now() / 3_600_000)}`,
      )

      return {
        url: String(session.url ?? ''),
        providerSessionId: String(session.id ?? ''),
      }
    },

    async createPortalSession(input) {
      const session = await post('/billing_portal/sessions', {
        customer: input.customerId,
        return_url: input.returnUrl,
      })

      return { url: String(session.url ?? '') }
    },

    verifyWebhook(rawBody, signatureHeader) {
      if (!verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret)) return null

      try {
        const parsed = JSON.parse(rawBody) as {
          id?: string
          type?: string
          created?: number
          data?: { object?: Record<string, unknown> }
        }

        if (!parsed.id || !parsed.type) return null

        return {
          id: parsed.id,
          type: parsed.type,
          data: parsed.data?.object ?? {},
          createdAt:
            typeof parsed.created === 'number' && Number.isFinite(parsed.created)
              ? new Date(parsed.created * 1000)
              : null,
        }
      } catch {
        return null
      }
    },
  }
}

/**
 * Verify a Stripe webhook signature.
 *
 * The part of a payment integration that absolutely must be right: without it,
 * anybody who finds the endpoint can declare any subscription active. The
 * scheme is documented and simple — HMAC-SHA256 over `timestamp.body` with the
 * endpoint secret — and it is testable without a network, which is why it is
 * separated out and covered by unit tests.
 *
 * The timestamp tolerance is a replay guard: a captured, correctly-signed
 * request must not be replayable a week later.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  { toleranceSeconds = 300, now = Date.now() } = {},
): boolean {
  if (!signatureHeader || !secret) return false

  const parts = new Map<string, string[]>()
  for (const segment of signatureHeader.split(',')) {
    const [key, value] = segment.split('=')
    if (!key || !value) continue
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()])
  }

  const timestamp = parts.get('t')?.[0]
  const signatures = parts.get('v1') ?? []

  if (!timestamp || signatures.length === 0) return false

  const age = Math.abs(now / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const expectedBuffer = Buffer.from(expected, 'hex')

  // Any one of the provided signatures may match, and each comparison is
  // constant time. A length mismatch is rejected before `timingSafeEqual`,
  // which throws on one — and throwing would itself be a signal.
  return signatures.some((candidate) => {
    const provided = Buffer.from(candidate, 'hex')
    if (provided.length !== expectedBuffer.length) return false
    return timingSafeEqual(provided, expectedBuffer)
  })
}

/* -------------------------------------------------------------------------- */

let cached: PaymentProvider | null | undefined
let override: PaymentProvider | undefined

/**
 * The configured provider, or null.
 *
 * Null is not an error state. It means this deployment does not take payments
 * through the application, which is correct for self-hosting and for any
 * organization whose billing is handled elsewhere.
 */
export function getPaymentProvider(): PaymentProvider | null {
  if (override) return override
  if (cached !== undefined) return cached

  const config = getBillingConfig()

  cached =
    config.provider === 'stripe' && config.stripe
      ? createStripeProvider({
          secretKey: config.stripe.secretKey,
          webhookSecret: config.stripe.webhookSecret,
          prices: config.stripe.prices,
        })
      : null

  return cached
}

export const isBillingConfigured = (): boolean => getPaymentProvider() !== null

/** Test seam. */
export function setPaymentProvider(provider: PaymentProvider | undefined): void {
  override = provider
  cached = undefined
}
