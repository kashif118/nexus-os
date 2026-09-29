/**
 * Formatters shared by server and client code.
 *
 * ## Why this file exists
 *
 * A module marked `'use client'` does not export plain functions to the server.
 * Next.js replaces every export of a client module with a client *reference*
 * when a Server Component imports it, so calling one on the server fails with
 * "Attempted to call X() from the server but X is on the client".
 *
 * Three pure formatters had been defined next to the client components that
 * happened to use them first, and were then imported by Server Components as
 * well — which crashes the page at render:
 *
 * - `formatBytes`   was in `documents/components/document-table.tsx`
 * - `relativeTime`  was in `notifications/components/notification-list.tsx`
 * - `initialsOf`    was in `components/ui/avatar.tsx`
 *
 * None of them touches state, hooks or a browser API, so none of them belonged
 * in a client module. They live here instead, exactly as `lib/money.ts` already
 * does for `formatMoney` — which is the pattern that was always correct and is
 * why that one never broke.
 *
 * The rule, stated once: **a helper used by both sides belongs in a module that
 * declares neither.** Putting it beside its first caller is what creates the
 * trap, because the second caller is usually on the other side of the boundary.
 */

/**
 * Human-readable size. Binary units, because storage quotas are quoted that way.
 *
 * Behaviour is preserved verbatim from the original definition: one decimal
 * place below 10, none at or above it — `1.5 KB`, `24 MB`. There is a second,
 * SEPARATE `formatBytes` in `modules/billing/plans.ts` which rounds differently
 * and understands `Infinity` as "unlimited". They are deliberately not merged
 * here: unifying them would change the output of one screen or the other, which
 * is not a thing a bug fix should do quietly.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/**
 * "3 minutes ago", without pulling in a date library for one string.
 *
 * `now` is injectable so a caller can render deterministically, and so this is
 * testable without freezing the clock.
 */
export function relativeTime(from: Date, now = new Date()): string {
  const seconds = Math.round((now.getTime() - from.getTime()) / 1000)
  if (seconds < 60) return 'just now'

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
    ['month', 2_592_000],
    ['year', 31_536_000],
  ]

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0]!

  for (const unit of units) {
    if (seconds >= unit[1]) chosen = unit
  }

  return formatter.format(-Math.round(seconds / chosen[1]), chosen[0])
}

/** Initials from a display name, for avatars with no image. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?'
}
