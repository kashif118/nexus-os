import { describe, expect, it } from 'vitest'

import { assessHealth, progressFromTasks, statusForScore, type HealthInputs } from '../health'

const base: HealthInputs = {
  status: 'ACTIVE',
  dueDate: null,
  completedAt: null,
  progressPercent: 50,
  totalTasks: 0,
  overdueTasks: 0,
  missedMilestones: 0,
  budgetMinor: null,
  spentMinor: null,
  now: new Date('2026-06-15T00:00:00.000Z'),
}

const daysFrom = (days: number) => new Date(Date.UTC(2026, 5, 15 + days))

describe('a project with no problems', () => {
  it('scores full marks', () => {
    const result = assessHealth(base)
    expect(result.score).toBe(100)
    expect(result.status).toBe('HEALTHY')
    expect(result.signals).toEqual([])
  })
})

describe('completed and archived projects', () => {
  it('treats a completed project as healthy regardless of history', () => {
    const result = assessHealth({
      ...base,
      status: 'COMPLETED',
      dueDate: daysFrom(-90),
      overdueTasks: 10,
      totalTasks: 10,
      missedMilestones: 5,
    })
    expect(result.status).toBe('HEALTHY')
    expect(result.score).toBe(100)
  })

  it('treats an archived project the same way', () => {
    expect(assessHealth({ ...base, status: 'ARCHIVED', dueDate: daysFrom(-30) }).status).toBe(
      'HEALTHY',
    )
  })

  it('does not penalise a project on hold', () => {
    const result = assessHealth({ ...base, status: 'ON_HOLD', dueDate: daysFrom(-30) })
    expect(result.score).toBe(100)
  })
})

describe('deadlines', () => {
  it('penalises an overdue project', () => {
    const result = assessHealth({ ...base, dueDate: daysFrom(-5) })
    expect(result.score).toBeLessThan(100)
    expect(result.signals[0]?.label).toMatch(/past the deadline/)
  })

  it('penalises more the later it is', () => {
    const slightly = assessHealth({ ...base, dueDate: daysFrom(-2) }).score
    const badly = assessHealth({ ...base, dueDate: daysFrom(-30) }).score
    expect(badly).toBeLessThan(slightly)
  })

  it('caps the overdue penalty so one signal cannot swamp the rest', () => {
    const result = assessHealth({ ...base, dueDate: daysFrom(-3650) })
    expect(result.signals[0]?.penalty).toBeLessThanOrEqual(40)
  })

  it('warns when a deadline is close and progress is behind', () => {
    const result = assessHealth({ ...base, dueDate: daysFrom(3), progressPercent: 20 })
    expect(result.status).not.toBe('HEALTHY')
  })

  it('does not warn when a deadline is close but the work is nearly done', () => {
    const result = assessHealth({ ...base, dueDate: daysFrom(3), progressPercent: 95 })
    expect(result.score).toBe(100)
  })

  it('ignores a deadline once the project is complete', () => {
    const result = assessHealth({ ...base, dueDate: daysFrom(-10), completedAt: daysFrom(-11) })
    expect(result.score).toBe(100)
  })
})

describe('overdue tasks', () => {
  it('ignores a trivial share', () => {
    expect(assessHealth({ ...base, totalTasks: 100, overdueTasks: 1 }).score).toBe(100)
  })

  it('penalises a significant share', () => {
    const result = assessHealth({ ...base, totalTasks: 10, overdueTasks: 5 })
    expect(result.score).toBeLessThan(100)
    expect(result.signals[0]?.label).toMatch(/5 of 10 tasks overdue/)
  })

  it('scales with the share', () => {
    const some = assessHealth({ ...base, totalTasks: 10, overdueTasks: 2 }).score
    const most = assessHealth({ ...base, totalTasks: 10, overdueTasks: 9 }).score
    expect(most).toBeLessThan(some)
  })

  it('handles a project with no tasks without dividing by zero', () => {
    expect(assessHealth({ ...base, totalTasks: 0, overdueTasks: 0 }).score).toBe(100)
  })
})

describe('milestones and budget', () => {
  it('penalises missed milestones', () => {
    const result = assessHealth({ ...base, missedMilestones: 2 })
    expect(result.signals[0]?.label).toMatch(/2 missed milestones/)
  })

  it('penalises going over budget', () => {
    const result = assessHealth({ ...base, budgetMinor: 100_000n, spentMinor: 150_000n })
    expect(result.signals[0]?.label).toMatch(/Over budget by 50%/)
  })

  it('warns when the budget is nearly spent but the work is not nearly done', () => {
    const result = assessHealth({
      ...base,
      budgetMinor: 100_000n,
      spentMinor: 95_000n,
      progressPercent: 40,
    })
    expect(result.score).toBeLessThan(100)
  })

  it('does not warn when spend matches progress', () => {
    const result = assessHealth({
      ...base,
      budgetMinor: 100_000n,
      spentMinor: 95_000n,
      progressPercent: 95,
    })
    expect(result.score).toBe(100)
  })

  it('handles a zero budget without dividing by zero', () => {
    expect(assessHealth({ ...base, budgetMinor: 0n, spentMinor: 100n }).score).toBe(100)
  })

  it('computes the budget ratio without floats', () => {
    // A third of a very large budget must not drift.
    const result = assessHealth({
      ...base,
      budgetMinor: 3_000_000_000_000n,
      spentMinor: 1_000_000_000_000n,
      progressPercent: 10,
    })
    expect(result.score).toBe(100)
  })
})

describe('combined signals', () => {
  it('accumulates penalties', () => {
    const result = assessHealth({
      ...base,
      dueDate: daysFrom(-10),
      totalTasks: 10,
      overdueTasks: 6,
      missedMilestones: 2,
    })
    expect(result.signals.length).toBe(3)
    expect(result.status).toBe('CRITICAL')
  })

  it('never goes below zero', () => {
    const result = assessHealth({
      ...base,
      dueDate: daysFrom(-365),
      totalTasks: 10,
      overdueTasks: 10,
      missedMilestones: 10,
      budgetMinor: 100n,
      spentMinor: 10_000n,
      status: 'AT_RISK',
    })
    expect(result.score).toBeGreaterThanOrEqual(0)
  })
})

describe('statusForScore', () => {
  it('maps scores to bands', () => {
    expect(statusForScore(100)).toBe('HEALTHY')
    expect(statusForScore(75)).toBe('HEALTHY')
    expect(statusForScore(74)).toBe('AT_RISK')
    expect(statusForScore(50)).toBe('AT_RISK')
    expect(statusForScore(49)).toBe('CRITICAL')
    expect(statusForScore(0)).toBe('CRITICAL')
  })
})

describe('progressFromTasks', () => {
  it('computes a percentage', () => {
    expect(progressFromTasks(5, 10)).toBe(50)
    expect(progressFromTasks(0, 10)).toBe(0)
    expect(progressFromTasks(10, 10)).toBe(100)
  })

  it('returns zero for a project with no tasks', () => {
    expect(progressFromTasks(0, 0)).toBe(0)
  })

  it('rounds to a whole percent', () => {
    expect(progressFromTasks(1, 3)).toBe(33)
  })
})
