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
}): Promise<{ organizationId: string } | null> {
  const db = getSystemDb()

  const subscription = await db.subscription.findUnique({
    where: { providerCustomerId: input.providerCustomerId },
    select: { id: true, organizationId: true },
  })

  // An event for a customer this deployment has never seen is not an error —
  // it is somebody else's data arriving at a shared endpoint, and is ignored.
  if (!subscription) return null

  await db.subscription.update({
    where: { id: subscription.id },
    data: {
      providerSubscriptionId: input.providerSubscriptionId,
      plan: input.plan,
      status: input.status as never,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelAt: input.cancelAt,
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
 * Record a provider event, refusing a repeat.
 *
 * Returns false when the event has already been seen. Webhooks are retried and
 * can arrive out of order; without this, a retried "updated" could undo a later
 * cancellation.
 */
export async function claimEvent(
  providerEventId: string,
  type: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await getSystemDb().billingEvent.create({
      data: { providerEventId, type, payload: payload as never },
    })
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    ) {
      return false
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
