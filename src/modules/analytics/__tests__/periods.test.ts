import { describe, expect, it } from 'vitest'

import { buckets, percentChange, previousRange, resolveRange } from '../periods'

const at = (iso: string) => new Date(iso)

describe('resolveRange', () => {
  it('covers exactly seven days for 7d, inclusive of today', () => {
    const range = resolveRange('7d', at('2026-03-15T10:00:00Z'))

    expect(range.from.toISOString()).toBe('2026-03-09T00:00:00.000Z')
    expect(range.to.toISOString()).toBe('2026-03-15T23:59:59.999Z')
    expect(range.granularity).toBe('day')
  })

  it('buckets 90 days by week and 12 months by month', () => {
    expect(resolveRange('90d', at('2026-03-15T00:00:00Z')).granularity).toBe('week')
    expect(resolveRange('12m', at('2026-03-15T00:00:00Z')).granularity).toBe('month')
  })

  it('starts year to date on 1 January', () => {
    const range = resolveRange('ytd', at('2026-08-20T12:00:00Z'))
    expect(range.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('works on the first day of a year without going negative', () => {
    const range = resolveRange('ytd', at('2026-01-01T06:00:00Z'))
    expect(range.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(range.to.getTime()).toBeGreaterThan(range.from.getTime())
  })
})

describe('previousRange', () => {
  it('is the same length, immediately before, with no overlap', () => {
    const range = resolveRange('30d', at('2026-03-31T00:00:00Z'))
    const previous = previousRange(range)

    const length = range.to.getTime() - range.from.getTime()
    const previousLength = previous.to.getTime() - previous.from.getTime()

    expect(previousLength).toBe(length)
    // Adjacent, not overlapping: one millisecond apart.
    expect(previous.to.getTime()).toBe(range.from.getTime() - 1)
  })

  it('compares like with like across a short month', () => {
    // February is 28 days; comparing a 30-day window against "last month" would
    // compare 30 days with 28. Same-length windows do not have that problem.
    const range = resolveRange('30d', at('2026-03-31T00:00:00Z'))
    const previous = previousRange(range)

    expect(previous.to.getTime() - previous.from.getTime()).toBe(
      range.to.getTime() - range.from.getTime(),
    )
  })
})

describe('buckets', () => {
  it('produces one bucket per day for a 7-day range', () => {
    const range = resolveRange('7d', at('2026-03-15T10:00:00Z'))
    const slots = buckets(range)

    expect(slots).toHaveLength(7)
    expect(slots[0]?.label).toBe('2026-03-09')
    expect(slots.at(-1)?.label).toBe('2026-03-15')
  })

  it('leaves no gap between consecutive buckets', () => {
    const range = resolveRange('30d', at('2026-03-15T10:00:00Z'))
    const slots = buckets(range)

    for (let index = 1; index < slots.length; index += 1) {
      expect(slots[index]!.start.getTime()).toBe(slots[index - 1]!.end.getTime() + 1)
    }
  })

  it('produces twelve monthly buckets for 12m', () => {
    const range = resolveRange('12m', at('2026-03-15T00:00:00Z'))
    const slots = buckets(range)

    expect(slots.length).toBeGreaterThanOrEqual(12)
    expect(slots[0]?.label).toBe('2025-04')
  })

  it('covers the whole range, so no row can fall outside every bucket', () => {
    const range = resolveRange('90d', at('2026-03-15T10:00:00Z'))
    const slots = buckets(range)

    expect(slots[0]!.start.getTime()).toBeLessThanOrEqual(range.from.getTime())
    expect(slots.at(-1)!.end.getTime()).toBeGreaterThanOrEqual(range.to.getTime())
  })
})

describe('percentChange', () => {
  it('computes an integer percentage', () => {
    expect(percentChange(150, 100)).toBe(50)
    expect(percentChange(50, 100)).toBe(-50)
    expect(percentChange(100, 100)).toBe(0)
  })

  it('returns null when there is no baseline', () => {
    // "Infinite growth" is not a useful thing to put on a dashboard.
    expect(percentChange(5, 0)).toBeNull()
    expect(percentChange(0, 0)).toBeNull()
  })

  it('handles a negative baseline without flipping the sign', () => {
    // Going from -100 to -50 is an improvement of 50%, not -50%.
    expect(percentChange(-50, -100)).toBe(50)
  })
})
