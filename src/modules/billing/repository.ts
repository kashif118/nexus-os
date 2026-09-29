import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

/** The first instant of the current month, UTC. */
export function periodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/* ----------------------------- subscriptions ------------------------------ */

export async function findSubscription(ctx: Ctx) {
  return ctx.db.subscription.findFirst({
    select: {
      id: true,
      plan: true,
      status: true,
      currentPeriodEnd: true,
      cancelAt: true,
      providerCustomerId: true,
      providerSubscriptionId: true,
      setManuallyAt: true,
      setManuallyById: true,
      updatedAt: true,
    },
  })
}

export async function upsertSubscription(ctx: Ctx, data: Record<string, unknown>) {
  const existing = await ctx.db.subscription.findFirst({ select: { id: true } })

  if (existing) {
    await ctx.db.subscription.updateMany({ where: { id: existing.id }, data: data as never })
    return existing
  }

  return ctx.db.subscription.create({
    data: { ...data, organizationId: ctx.orgId } as never,
    select: { id: true },
  })
}

/**
 * Apply a change from a verified provider event.
 *
 * Uses the system client because a webhook has no session and no organization
 * until the provider's customer id is matched to one — which is exactly what
 * this does.
 */
export async function applyProviderState(input: {
  providerCustomerId: string
  providerSubscriptionId: string | null
  plan: string
  status: string
  currentPeriodEnd: Date | null
  cancelAt: Date | null
  /** The provider's own timestamp for the event carrying this state. */
  eventCreatedAt: Date | null
}): Promise<{ organizationId: string; stale?: boolean } | null> {
  const db = getSystemDb()

  const subscription = await db.subscription.findUnique({
    where: { providerCustomerId: input.providerCustomerId },
    select: { id: true, organizationId: true, lastProviderEventAt: true },
  })

  // An event for a customer this deployment has never seen is not an error —
  // it is somebody else's data arriving at a shared endpoint, and is ignored.
  if (!subscription) return null

  /*
   * Refuse state older than what has already been applied.
   *
   * Webhook delivery is not ordered. A `customer.subscription.updated` that was
   * retried after a timeout can land AFTER the `customer.subscription.deleted`
   * that followed it, and without this guard the older payload would win —
   * silently reactivating a cancelled subscription and restoring paid features
   * to somebody who cancelled.
   *
   * Idempotency by event id does not cover this: these are two DIFFERENT events,
   * each processed exactly once, in the wrong order.
   *
   * An event with no timestamp is applied, because refusing it would mean
   * dropping state on a provider that does not send one.
   */
  if (
    input.eventCreatedAt &&
    subscription.lastProviderEventAt &&
    input.eventCreatedAt < subscription.lastProviderEventAt
  ) {
    return { organizationId: subscription.organizationId, stale: true }
  }

  await db.subscription.update({
    where: { id: subscription.id },
    data: {
      providerSubscriptionId: input.providerSubscriptionId,
      plan: input.plan,
      status: input.status as never,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelAt: input.cancelAt,
      lastProviderEventAt: input.eventCreatedAt ?? subscription.lastProviderEventAt,
      // A provider event supersedes any manual setting.
      setManuallyAt: null,
      setManuallyById: null,
    },
  })

  return { organizationId: subscription.organizationId }
}

/**
 * Link a provider customer to an organization.
 *
 * Reached only from a signature-verified webhook, which has no session — hence
 * the system client and the explicit organization id, which came from metadata
 * this application put on the checkout session itself.
 */
export async function linkProviderCustomer(
  organizationId: string,
  providerCustomerId: string,
): Promise<void> {
  const db = getSystemDb()

  const existing = await db.subscription.findUnique({
    where: { organizationId },
    select: { id: true },
  })

  if (existing) {
    await db.subscription.update({
      where: { id: existing.id },
      data: { providerCustomerId },
    })
    return
  }

  await db.subscription.create({
    data: { organizationId, providerCustomerId, plan: 'free', status: 'NONE' },
  })
}

/* ------------------------------ usage counts ------------------------------ */

export async function countSeats(ctx: Ctx): Promise<number> {
  return ctx.db.membership.count({ where: { status: 'ACTIVE' } })
}

export async function countProjects(ctx: Ctx): Promise<number> {
  return ctx.db.project.count({ where: { deletedAt: null, status: { not: 'ARCHIVED' } } })
}

export async function sumStorageBytes(ctx: Ctx): Promise<number> {
  const result = await ctx.db.document.aggregate({
    where: { deletedAt: null },
    _sum: { sizeBytes: true },
  })
  return result._sum.sizeBytes ?? 0
}

export async function countWorkflowRunsThisPeriod(ctx: Ctx): Promise<number> {
  return ctx.db.workflowRun.count({ where: { startedAt: { gte: periodStart() } } })
}

export async function aiSpendThisPeriod(ctx: Ctx): Promise<number> {
  const counter = await ctx.db.aIUsageCounter.findFirst({
    where: { periodStart: periodStart() },
    select: { costMicros: true },
  })
  return counter?.costMicros ?? 0
}

/* ---------------------------- metered counters ---------------------------- */

/**
 * Increment a metered counter.
 *
 * Read-then-write, because `periodStart` is part of a compound unique that
 * Prisma can address but the metric enum makes verbose; the increment itself is
 * atomic, which is what protects against two concurrent writers losing a count.
 */
export async function addUsage(
  ctx: Ctx,
  metric: 'AI_TOKENS' | 'WORKFLOW_RUNS' | 'STORAGE_BYTES' | 'SEATS' | 'PROJECTS',
  amount: bigint,
): Promise<void> {
  const start = periodStart()

  const existing = await ctx.db.usageCounter.findFirst({
    where: { metric, periodStart: start },
    select: { id: true },
  })

  if (existing) {
    await ctx.db.usageCounter.updateMany({
      where: { id: existing.id },
      data: { value: { increment: amount } },
    })
    return
  }

  await ctx.db.usageCounter.create({
    data: { organizationId: ctx.orgId, metric, periodStart: start, value: amount },
  })
}

/* ------------------------------ billing events ---------------------------- */

/**
 * Claim a provider event for processing.
 *
 * Returns false when this event has already been processed SUCCESSFULLY, which
 * is what makes delivery idempotent: the provider retries, and a repeat is a
 * no-op.
 *
 * The distinction between "seen" and "processed" is the correction here, and it
 * mattered. The previous version refused any event whose id already existed —
 * including one whose first attempt had FAILED. The sequence was:
 *
 *   1. attempt one claims the row, handling throws, the route answers 500
 *      so that the provider will retry;
 *   2. the provider retries; the row exists, so the claim is refused;
 *   3. the route answers 200 "already processed", and the event is lost.
 *
 * So a transient failure — a database blip during a subscription update — meant
 * that subscription never reached the state the provider had. The retry the 500
 * was asking for could never succeed.
 *
 * An unprocessed row is therefore re-claimable. The re-claim is a conditional
 * update on `processedAt IS NULL`, so if two deliveries of the same failed
 * event arrive together exactly one proceeds.
 */
export async function claimEvent(
  providerEventId: string,
  type: string,
  payload: unknown,
  providerCreatedAt: Date | null = null,
): Promise<boolean> {
  const db = getSystemDb()

  try {
    await db.billingEvent.create({
      data: { providerEventId, type, payload: payload as never, attempts: 1, providerCreatedAt },
    })
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    ) {
      const reclaimed = await db.billingEvent.updateMany({
        where: { providerEventId, processedAt: null },
        data: { attempts: { increment: 1 }, error: null },
      })

      return reclaimed.count > 0
    }
    throw error
  }
}

export async function settleEvent(
  providerEventId: string,
  input: { organizationId: string | null; error: string | null },
): Promise<void> {
  await getSystemDb().billingEvent.updateMany({
    where: { providerEventId },
    data: {
      organizationId: input.organizationId,
      processedAt: input.error ? null : new Date(),
      error: input.error,
    },
  })
}

export async function listEvents(ctx: Ctx, limit = 25) {
  return getSystemDb().billingEvent.findMany({
    where: { organizationId: ctx.orgId },
    orderBy: { receivedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      receivedAt: true,
      processedAt: true,
      error: true,
    },
  })
}
