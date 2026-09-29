/**
 * The plan catalogue.
 *
 * Plans are code, not rows. Two reasons:
 *
 * 1. **A limit is a behaviour.** It is enforced by the entitlement service, and
 *    an editable-in-the-database limit is an editable-in-the-database security
 *    boundary — the same argument as the agent system prompt.
 * 2. **Prices here are display only.** The authority for what somebody is
 *    charged is the payment provider, which holds the real price objects. A
 *    number in this table that drifts from the provider's is a display bug;
 *    a number here that were treated as authoritative would be a billing bug.
 *
 * `Infinity` means genuinely no limit, and is written as such rather than as a
 * large number that somebody might one day hit.
 */

export type PlanKey = 'free' | 'team' | 'business'

export interface PlanLimits {
  /** Active members, including the owner. */
  seats: number
  /** Projects that are not archived. */
  projects: number
  /** Total stored document bytes. */
  storageBytes: number
  /** AI spend per month, in micros of USD. */
  aiBudgetMicros: number
  /** Workflow runs per month. */
  workflowRuns: number
}

export interface PlanDefinition {
  key: PlanKey
  name: string
  description: string
  /** Display only. The provider holds the price that is actually charged. */
  monthlyPriceMinor: number
  currency: string
  limits: PlanLimits
  highlights: string[]
}

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    key: 'free',
    name: 'Free',
    description: 'For a small team getting started. No card required, no trial clock.',
    monthlyPriceMinor: 0,
    currency: 'USD',
    limits: {
      seats: 10,
      projects: 10,
      storageBytes: 2 * 1024 * 1024 * 1024,
      aiBudgetMicros: 2_000_000,
      workflowRuns: 100,
    },
    highlights: ['10 members', '10 projects', '2 GB of documents', 'Everything except the limits'],
  },
  team: {
    key: 'team',
    name: 'Team',
    description: 'For a team running real delivery work.',
    monthlyPriceMinor: 4_900,
    currency: 'USD',
    limits: {
      seats: 25,
      projects: 50,
      storageBytes: 50 * 1024 * 1024 * 1024,
      aiBudgetMicros: 50_000_000,
      workflowRuns: 5_000,
    },
    highlights: ['25 members', '50 projects', '50 GB of documents', 'Higher AI budget'],
  },
  business: {
    key: 'business',
    name: 'Business',
    description: 'For an organization running everything here.',
    monthlyPriceMinor: 19_900,
    currency: 'USD',
    limits: {
      seats: Infinity,
      projects: Infinity,
      storageBytes: 500 * 1024 * 1024 * 1024,
      aiBudgetMicros: 250_000_000,
      workflowRuns: 50_000,
    },
    highlights: [
      'Unlimited members and projects',
      '500 GB of documents',
      'Highest AI budget',
      'API access',
    ],
  },
}

export const PLAN_ORDER: PlanKey[] = ['free', 'team', 'business']

export function isPlanKey(value: string): value is PlanKey {
  return Object.hasOwn(PLANS, value)
}

/**
 * The plan in force, falling back to free.
 *
 * An unknown key — a plan removed in a later version, a corrupted row — means
 * free-tier limits, never unlimited. Failing open on an entitlement check is
 * how a limit stops being a limit.
 */
export function planFor(key: string | null | undefined): PlanDefinition {
  return key && isPlanKey(key) ? PLANS[key] : PLANS.free
}

/**
 * Whether a subscription status entitles the organization to its paid plan.
 *
 * `PAST_DUE` still does: a failed card should not delete somebody's access to
 * their own data mid-month. `CANCELED` does not, and falls back to free.
 */
export function entitledPlan(
  planKey: string | null | undefined,
  status: string | null | undefined,
): PlanDefinition {
  if (status === 'CANCELED' || status === 'NONE' || !status) return PLANS.free
  return planFor(planKey)
}

/** Human-readable byte size, for limit messages. */
export function formatBytes(bytes: number): string {
  if (bytes === Infinity) return 'unlimited'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

export function formatLimit(value: number): string {
  return value === Infinity ? 'unlimited' : new Intl.NumberFormat('en').format(value)
}
