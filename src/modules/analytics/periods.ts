/**
 * Period arithmetic — pure, and tested.
 *
 * Every date boundary here is UTC. That is a choice with a cost: a user in
 * Auckland sees "today" end at 13:00 local. The alternative — computing
 * boundaries in each organization's time zone — means a metric's value depends
 * on who is looking at it, and two people comparing screens get different
 * numbers for the same question. A single, stated basis is worth more than a
 * locally intuitive one, and the UI says the basis.
 */

export const PERIODS = ['7d', '30d', '90d', '12m', 'ytd'] as const
export type PeriodKey = (typeof PERIODS)[number]

export interface Range {
  from: Date
  to: Date
  /** How the series is bucketed within the range. */
  granularity: 'day' | 'week' | 'month'
  label: string
}

export function isPeriodKey(value: string): value is PeriodKey {
  return (PERIODS as readonly string[]).includes(value)
}

export function resolveRange(period: PeriodKey, now = new Date()): Range {
  const to = endOfDay(now)

  switch (period) {
    case '7d':
      return { from: startOfDay(addDays(now, -6)), to, granularity: 'day', label: 'Last 7 days' }
    case '30d':
      return { from: startOfDay(addDays(now, -29)), to, granularity: 'day', label: 'Last 30 days' }
    case '90d':
      return { from: startOfDay(addDays(now, -89)), to, granularity: 'week', label: 'Last 90 days' }
    case '12m':
      return {
        from: startOfMonth(addMonths(now, -11)),
        to,
        granularity: 'month',
        label: 'Last 12 months',
      }
    case 'ytd':
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        to,
        granularity: 'month',
        label: 'Year to date',
      }
  }
}

/**
 * The equivalent range immediately before this one, for comparison.
 *
 * Same LENGTH, not the same calendar period: comparing a 30-day window against
 * the previous 30 days is a like-for-like comparison, whereas comparing it
 * against "last month" compares 30 days with 28 or 31.
 */
export function previousRange(range: Range): Range {
  const length = range.to.getTime() - range.from.getTime()
  return {
    from: new Date(range.from.getTime() - length - 1),
    to: new Date(range.from.getTime() - 1),
    granularity: range.granularity,
    label: `Previous ${range.label.toLowerCase()}`,
  }
}

/** The bucket boundaries covering a range, oldest first. */
export function buckets(range: Range): Array<{ start: Date; end: Date; label: string }> {
  const out: Array<{ start: Date; end: Date; label: string }> = []

  if (range.granularity === 'month') {
    let cursor = startOfMonth(range.from)
    while (cursor <= range.to) {
      const next = addMonths(cursor, 1)
      out.push({
        start: cursor,
        end: new Date(next.getTime() - 1),
        label: cursor.toISOString().slice(0, 7),
      })
      cursor = next
    }
    return out
  }

  const step = range.granularity === 'week' ? 7 : 1
  let cursor = startOfDay(range.from)

  while (cursor <= range.to) {
    const next = addDays(cursor, step)
    out.push({
      start: cursor,
      end: new Date(next.getTime() - 1),
      label: cursor.toISOString().slice(0, 10),
    })
    cursor = next
  }

  return out
}

/**
 * Percentage change, as an integer, guarding the zero-baseline case.
 *
 * Returns null when the previous value was zero: "infinite growth" is not a
 * useful thing to show, and 0 → 5 is better described as "5, up from none".
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / Math.abs(previous)) * 100)
}

/* ------------------------------ date helpers ------------------------------ */

export const startOfDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

export const endOfDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))

export const startOfMonth = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000)

export const addMonths = (date: Date, months: number): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()))
