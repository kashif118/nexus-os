/**
 * Project health scoring.
 *
 * A single "at risk" flag someone sets by hand goes stale immediately, so health
 * is DERIVED from the project data and recomputed on write. This module is the
 * whole definition, kept pure so every rule is testable without a database and
 * so the thresholds are reviewable in one place rather than scattered through
 * queries.
 *
 * The score starts at 100 and loses points for each signal. Points rather than a
 * boolean because it degrades gradually: a project one day late with everything
 * else fine should not read the same as one a month late with half its tasks
 * overdue.
 */

export type HealthStatus = 'HEALTHY' | 'AT_RISK' | 'CRITICAL'

/** Thresholds, named so the numbers in `assessHealth` are not bare magic. */
export const HEALTH_THRESHOLDS = {
  /** Below this the project is CRITICAL; below AT_RISK it is AT_RISK. */
  critical: 50,
  atRisk: 75,

  /** A deadline this close counts as "approaching". */
  deadlineSoonDays: 7,

  /** Share of tasks overdue that starts costing points. */
  overdueTaskShare: 0.1,

  /** Share of budget consumed that starts costing points. */
  budgetWarningShare: 0.9,
} as const

export interface HealthInputs {
  status: string
  dueDate: Date | null
  completedAt: Date | null
  progressPercent: number
  /** Task counts. Zero when the task module has nothing for this project yet. */
  totalTasks: number
  overdueTasks: number
  /** Milestones that are past due and not complete. */
  missedMilestones: number
  /** Budget consumed vs allocated, both in minor units. Null when no budget. */
  budgetMinor: bigint | null
  spentMinor: bigint | null
  now?: Date
}

export interface HealthAssessment {
  score: number
  status: HealthStatus
  /** Why the score is what it is, shown to the user rather than hidden. */
  signals: Array<{ label: string; penalty: number }>
}

/**
 * Assess a project.
 *
 * Deliberately returns the reasons alongside the number: a health indicator that
 * cannot explain itself gets ignored.
 */
export function assessHealth(inputs: HealthInputs): HealthAssessment {
  const now = inputs.now ?? new Date()
  const signals: Array<{ label: string; penalty: number }> = []

  // A finished or shelved project is not "at risk" — there is nothing to rescue.
  if (inputs.status === 'COMPLETED' || inputs.status === 'ARCHIVED') {
    return { score: 100, status: 'HEALTHY', signals }
  }

  if (inputs.status === 'ON_HOLD') {
    return { score: 100, status: 'HEALTHY', signals: [{ label: 'On hold', penalty: 0 }] }
  }

  const add = (label: string, penalty: number) => {
    if (penalty > 0) signals.push({ label, penalty })
  }

  /* --- deadline ---------------------------------------------------------- */

  if (inputs.dueDate && !inputs.completedAt) {
    const daysRemaining = Math.ceil(
      (inputs.dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    )

    if (daysRemaining < 0) {
      // Overdue: escalates with how late it is, capped so one signal cannot
      // swamp every other.
      const daysLate = Math.abs(daysRemaining)
      add(
        `${daysLate} day${daysLate === 1 ? '' : 's'} past the deadline`,
        Math.min(40, 15 + daysLate),
      )
    } else if (daysRemaining <= HEALTH_THRESHOLDS.deadlineSoonDays && inputs.progressPercent < 80) {
      // Close to the deadline without being close to done. The penalty scales
      // with the shortfall: a week out at 75% is a nudge, a week out at 20% is
      // the single most useful warning this indicator can give.
      const shortfall = 80 - inputs.progressPercent
      add(
        `Due in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} at ${inputs.progressPercent}% complete`,
        Math.min(35, Math.round(shortfall / 2)),
      )
    }
  }

  /* --- tasks ------------------------------------------------------------- */

  if (inputs.totalTasks > 0 && inputs.overdueTasks > 0) {
    const share = inputs.overdueTasks / inputs.totalTasks
    if (share >= HEALTH_THRESHOLDS.overdueTaskShare) {
      // Proportional: 100% overdue costs 30, 10% costs 3.
      add(
        `${inputs.overdueTasks} of ${inputs.totalTasks} tasks overdue`,
        Math.min(30, Math.round(share * 30)),
      )
    }
  }

  /* --- milestones -------------------------------------------------------- */

  if (inputs.missedMilestones > 0) {
    add(
      `${inputs.missedMilestones} missed milestone${inputs.missedMilestones === 1 ? '' : 's'}`,
      Math.min(25, inputs.missedMilestones * 10),
    )
  }

  /* --- budget ------------------------------------------------------------ */

  if (inputs.budgetMinor && inputs.budgetMinor > 0n && inputs.spentMinor !== null) {
    // Ratio computed in integers scaled by 1000 to avoid a float entirely.
    const consumedPerMille = Number((inputs.spentMinor * 1000n) / inputs.budgetMinor)
    const consumed = consumedPerMille / 1000

    if (consumed > 1) {
      add(`Over budget by ${Math.round((consumed - 1) * 100)}%`, 25)
    } else if (consumed >= HEALTH_THRESHOLDS.budgetWarningShare && inputs.progressPercent < 90) {
      add(
        `${Math.round(consumed * 100)}% of budget used at ${inputs.progressPercent}% complete`,
        15,
      )
    }
  }

  /* --- explicit status --------------------------------------------------- */

  if (inputs.status === 'AT_RISK') {
    add('Flagged at risk', 20)
  }

  const penalty = signals.reduce((sum, signal) => sum + signal.penalty, 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))

  return { score, status: statusForScore(score), signals }
}

export function statusForScore(score: number): HealthStatus {
  if (score < HEALTH_THRESHOLDS.critical) return 'CRITICAL'
  if (score < HEALTH_THRESHOLDS.atRisk) return 'AT_RISK'
  return 'HEALTHY'
}

/** Progress from completed task share, rounded to a whole percent. */
export function progressFromTasks(completed: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
}
