import { writeAuditLog } from '@/kernel/audit/write'
import { clientEnv, getBillingConfig } from '@/kernel/config/env'
import { conflict, notFound, validationError } from '@/kernel/errors'
import { log } from '@/kernel/observability/logger'
import type { Ctx } from '@/kernel/tenancy/ctx'

import { usageFor } from './entitlements'
import { isPlanKey, PLANS, PLAN_ORDER, planFor } from './plans'
import { getPaymentProvider, isBillingConfigured, type ProviderEvent } from './provider'
import * as repository from './repository'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * Billing.
 *
 * The invariant, restated because it is the whole point: **nothing marks a
 * subscription paid except a verified provider event.** `startCheckout` returns
 * a URL and changes nothing. The success redirect changes nothing. Only
 * `applyProviderEvent`, reached from a signature-verified webhook, moves a
 * subscription into an active state.
 */

export async function getBillingOverview(ctx: Ctx) {
  ctx.require('organization.read')

  const [subscription, usage, events] = await Promise.all([
    repository.findSubscription(ctx),
    usageFor(ctx),
    ctx.can('organization.billing.manage') ? repository.listEvents(ctx) : Promise.resolve([]),
  ])

  return {
    configured: isBillingConfigured(),
    subscription,
    usage,
    events,
    plans: PLAN_ORDER.map((key) => PLANS[key]),
    canManage: ctx.can('organization.billing.manage'),
  }
}

/**
 * Begin a checkout.
 *
 * Returns a provider URL and NOTHING ELSE changes. The organization's plan is
 * not touched, no status is set, and the caller is not entitled to anything
 * more than they were a moment ago.
 */
export async function startCheckout(
  ctx: Ctx,
  planKey: string,
  meta: RequestMeta,
): Promise<{ url: string }> {
  ctx.require('organization.billing.manage')

  const provider = getPaymentProvider()
  if (!provider) {
    throw conflict(
      'This deployment does not take payments. An owner can set the plan directly, or configure a payment provider.',
    )
  }

  if (!isPlanKey(planKey) || planKey === 'free') {
    throw validationError('Choose a paid plan.')
  }

  const subscription = await repository.findSubscription(ctx)
  const base = clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')

  const session = await provider.createCheckout({
    organizationId: ctx.orgId,
    planKey,
    customerEmail: ctx.user.email,
    successUrl: `${base}/${ctx.orgSlug}/settings/billing?checkout=complete`,
    cancelUrl: `${base}/${ctx.orgSlug}/settings/billing?checkout=cancelled`,
    existingCustomerId: subscription?.providerCustomerId ?? null,
  })

  await writeAuditLog({
    action: 'billing.checkout_started',
    entityType: 'Subscription',
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    // Recorded as STARTED. Nothing here claims it completed.
    metadata: { plan: planKey, sessionId: session.providerSessionId },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { url: session.url }
}

export async function openBillingPortal(ctx: Ctx): Promise<{ url: string }> {
  ctx.require('organization.billing.manage')

  const provider = getPaymentProvider()
  if (!provider) throw conflict('This deployment does not take payments.')

  const subscription = await repository.findSubscription(ctx)
  if (!subscription?.providerCustomerId) {
    throw notFound('There is no billing account for this organization yet.')
  }

  const base = clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')

  return provider.createPortalSession({
    customerId: subscription.providerCustomerId,
    returnUrl: `${base}/${ctx.orgSlug}/settings/billing`,
  })
}

/**
 * Set the plan by hand.
 *
 * Only where no payment provider is configured — a self-hosted deployment, or
 * an organization invoiced outside the application. It is recorded as MANUAL,
 * with who did it, so a later reconciliation can tell "we saw a payment" from
 * "somebody said so". With a provider configured this is refused outright:
 * otherwise it would be a way to grant paid features without paying.
 */
export async function setPlanManually(ctx: Ctx, planKey: string, meta: RequestMeta): Promise<void> {
  ctx.require('organization.billing.manage')

  if (isBillingConfigured()) {
    throw conflict(
      'This deployment takes payments through a provider, so the plan follows the subscription rather than being set by hand.',
    )
  }

  if (!isPlanKey(planKey)) throw validationError('That plan does not exist.')

  await repository.upsertSubscription(ctx, {
    plan: planKey,
    status: planKey === 'free' ? 'NONE' : 'ACTIVE',
    setManuallyById: ctx.userId,
    setManuallyAt: new Date(),
    // Explicitly NOT setting a period end: there is no payment behind this, so
    // there is no paid period to claim.
    currentPeriodEnd: null,
  })

  await writeAuditLog({
    action: 'billing.plan_set_manually',
    entityType: 'Subscription',
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { plan: planKey },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS_MAP: Record<string, string> = {
  active: 'ACTIVE',
  trialing: 'TRIALING',
  past_due: 'PAST_DUE',
  unpaid: 'PAST_DUE',
  canceled: 'CANCELED',
  incomplete: 'NONE',
  incomplete_expired: 'NONE',
}

/**
 * Apply a verified provider event.
 *
 * The ONLY path that moves a subscription into a paid state. Idempotent by the
 * provider's event id, because webhooks are retried and can arrive out of
 * order — without that, a retried "updated" could undo a later cancellation.
 */
export async function applyProviderEvent(
  event: ProviderEvent,
): Promise<{ applied: boolean; reason?: string }> {
  const fresh = await repository.claimEvent(event.id, event.type, event.data, event.createdAt)
  if (!fresh) return { applied: false, reason: 'Already processed.' }

  try {
    const handled = await handleEvent(event)
    await repository.settleEvent(event.id, { organizationId: handled, error: null })
    return { applied: handled !== null }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : 'Failed to apply.'
    await repository.settleEvent(event.id, { organizationId: null, error: message })
    throw error
  }
}

async function handleEvent(event: ProviderEvent): Promise<string | null> {
  const data = event.data

  if (event.type === 'checkout.session.completed') {
    const customerId = stringOf(data.customer)
    const organizationId = stringOf((data.metadata as Record<string, unknown>)?.organizationId)

    if (!customerId || !organizationId) return null

    // Link the provider's customer to the tenant. The plan and status still
    // come from the subscription event that follows; a completed checkout is
    // not by itself a statement that money moved.
    await repository.linkProviderCustomer(organizationId, customerId)

    return organizationId
  }

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const customerId = stringOf(data.customer)
    if (!customerId) return null

    const status =
      event.type === 'customer.subscription.deleted'
        ? 'CANCELED'
        : (STATUS_MAP[stringOf(data.status) ?? ''] ?? 'NONE')

    const applied = await repository.applyProviderState({
      providerCustomerId: customerId,
      providerSubscriptionId: stringOf(data.id),
      plan: planFromPrice(data),
      status,
      currentPeriodEnd: periodEndOf(data),
      cancelAt: epochToDate(data.cancel_at),
      eventCreatedAt: event.createdAt,
    })

    if (applied?.stale) {
      // Recorded, deliberately not acted on: this event is older than state
      // already applied, so honouring it would move the subscription backwards.
      log.warn('billing.event.stale', {
        organizationId: applied.organizationId,
        event: event.type,
        eventId: event.id,
      })
      return applied.organizationId
    }

    if (applied) {
      await writeAuditLog({
        action: 'billing.subscription_changed',
        entityType: 'Subscription',
        organizationId: applied.organizationId,
        actorType: 'SYSTEM',
        metadata: { status, event: event.type },
      })
    }

    return applied?.organizationId ?? null
  }

  // An event type this version does not handle is recorded and ignored, not
  // an error: the provider sends many, and most are not ours to act on.
  return null
}

/**
 * Work out the plan from the subscription's price.
 *
 * Matched against the configured price ids. An unrecognised price falls back to
 * free rather than guessing — granting a plan on a price this deployment does
 * not know about would be granting it on somebody else's say-so.
 */
function planFromPrice(data: Record<string, unknown>): string {
  const items = (data.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data
  const priceId = items?.[0]?.price?.id

  if (!priceId) return 'free'

  const prices = getBillingConfig().stripe?.prices ?? {}
  const match = Object.entries(prices).find(([, id]) => id === priceId)

  return match?.[0] ?? 'free'
}

const stringOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const epochToDate = (value: unknown): Date | null =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null

/**
 * When the current paid period ends — read from either place Stripe puts it.
 *
 * Stripe moved `current_period_end` off the subscription and onto each
 * subscription ITEM in API version `2025-03-31.basil`. Which one arrives depends
 * on the API version pinned to the account sending the webhook, and that is not
 * something this application controls or can detect in advance.
 *
 * Reading only the subscription level — as this did — means a deployment on a
 * newer API version silently stores `null`: no renewal date on the billing
 * screen, and no error anywhere to explain why. Reading only the item level
 * would break every account still on an older version.
 *
 * So: subscription first, then the first item. A subscription with several items
 * is a billing arrangement this product does not create, and taking the first is
 * the same answer Stripe's own migration guidance gives.
 */
function periodEndOf(data: Record<string, unknown>): Date | null {
  const subscriptionLevel = epochToDate(data.current_period_end)
  if (subscriptionLevel) return subscriptionLevel

  const items = (data.items as { data?: Array<Record<string, unknown>> } | undefined)?.data
  return epochToDate(items?.[0]?.current_period_end)
}

export { planFor, isBillingConfigured }
