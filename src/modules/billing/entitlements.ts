import type { Ctx } from '@/kernel/tenancy/ctx'
import { AppError } from '@/kernel/errors'

import { entitledPlan, formatBytes, formatLimit, type PlanDefinition } from './plans'
import * as repository from './repository'

/**
 * Entitlements.
 *
 * Every limit is checked BEFORE the operation it governs, on the server, in the
 * service that performs it. A limit enforced only in the UI is a suggestion,
 * and one checked after the write is an apology.
 *
 * Counts are taken live from the source tables rather than from a counter that
 * could drift. Seats and projects are cheap to count; storage is summed from
 * the document rows, which is the same figure the documents screen shows. The
 * `UsageCounter` table exists for the two metrics that genuinely accumulate
 * over a period — AI spend and workflow runs — where counting live would mean
 * scanning a month of history on every check.
 */

export class EntitlementError extends AppError {
  constructor(
    message: string,
    readonly metric: string,
    readonly limit: number,
    readonly current: number,
  ) {
    super('ENTITLEMENT_REQUIRED', message)
    this.name = 'EntitlementError'
  }
}

export type LimitedMetric =
  'seats' | 'projects' | 'storageBytes' | 'workflowRuns' | 'aiBudgetMicros'

export interface UsageSnapshot {
  plan: PlanDefinition
  seats: { used: number; limit: number }
  projects: { used: number; limit: number }
  storageBytes: { used: number; limit: number }
  workflowRuns: { used: number; limit: number }
  aiBudgetMicros: { used: number; limit: number }
}

/** Everything a billing screen needs, and what every check reads. */
export async function usageFor(ctx: Ctx): Promise<UsageSnapshot> {
  const subscription = await repository.findSubscription(ctx)
  const plan = entitledPlan(subscription?.plan, subscription?.status)

  const [seats, projects, storage, workflowRuns, aiMicros] = await Promise.all([
    repository.countSeats(ctx),
    repository.countProjects(ctx),
    repository.sumStorageBytes(ctx),
    repository.countWorkflowRunsThisPeriod(ctx),
    repository.aiSpendThisPeriod(ctx),
  ])

  return {
    plan,
    seats: { used: seats, limit: plan.limits.seats },
    projects: { used: projects, limit: plan.limits.projects },
    storageBytes: { used: storage, limit: plan.limits.storageBytes },
    workflowRuns: { used: workflowRuns, limit: plan.limits.workflowRuns },
    aiBudgetMicros: { used: aiMicros, limit: plan.limits.aiBudgetMicros },
  }
}

/**
 * Refuse an operation that would exceed a limit.
 *
 * `additional` is how much the operation is about to add, so the check is
 * against the state AFTER it — inviting the 26th member on a 25-seat plan is
 * refused before the invitation is written, not after somebody accepts it.
 */
export async function requireCapacity(
  ctx: Ctx,
  metric: LimitedMetric,
  additional = 1,
): Promise<void> {
  const usage = await usageFor(ctx)
  const entry = usage[metric]

  if (entry.limit === Infinity) return
  if (entry.used + additional <= entry.limit) return

  throw new EntitlementError(
    describe(metric, entry.limit, usage.plan),
    metric,
    entry.limit,
    entry.used,
  )
}

/** Whether there is room, without throwing — for rendering a disabled control. */
export async function hasCapacity(
  ctx: Ctx,
  metric: LimitedMetric,
  additional = 1,
): Promise<boolean> {
  const usage = await usageFor(ctx)
  const entry = usage[metric]
  return entry.limit === Infinity || entry.used + additional <= entry.limit
}

function describe(metric: LimitedMetric, limit: number, plan: PlanDefinition): string {
  const suffix = `The ${plan.name} plan allows`

  switch (metric) {
    case 'seats':
      return `${suffix} ${formatLimit(limit)} members. Remove someone, or move to a larger plan.`
    case 'projects':
      return `${suffix} ${formatLimit(limit)} active projects. Archive one, or move to a larger plan.`
    case 'storageBytes':
      return `${suffix} ${formatBytes(limit)} of documents. Delete something, or move to a larger plan.`
    case 'workflowRuns':
      return `${suffix} ${formatLimit(limit)} workflow runs a month. It resets at the start of next month.`
    case 'aiBudgetMicros':
      return `${suffix} a monthly AI budget that has been reached. It resets at the start of next month.`
  }
}
