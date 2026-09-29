import { describe, expect, it } from 'vitest'

import { formatBytes, initialsOf, relativeTime } from '../format'

/**
 * The shared formatters.
 *
 * These three were moved out of `'use client'` modules because Server
 * Components were importing them, which crashes at render. The move must not
 * have changed a single character of output — so the expectations below are the
 * behaviour as it was, written down, rather than the behaviour somebody would
 * choose today.
 *
 * `formatBytes` in particular is deliberately NOT the same function as the one
 * in `modules/billing/plans.ts`: that one rounds differently and understands
 * `Infinity`. Merging them would change one screen or the other, so both stay.
 */

describe('formatBytes', () => {
  it('reports plain bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('uses one decimal place below ten, and none at or above', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 10)).toBe('10 KB')
    expect(formatBytes(1024 * 999)).toBe('999 KB')
  })

  it('climbs through the binary units', () => {
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
    // Stops at TB rather than inventing a unit nobody reads.
    expect(formatBytes(1024 ** 5)).toBe('1024 TB')
  })

  it('differs from the billing formatter, which is why both exist', async () => {
    const { formatBytes: billingFormat } = await import('@/modules/billing/plans')

    // Same input, deliberately different output. Documented, not accidental.
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(billingFormat(1024)).toBe('1 KB')
    expect(billingFormat(Infinity)).toBe('unlimited')
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)

  it('says "just now" under a minute', () => {
    expect(relativeTime(ago(0), now)).toBe('just now')
    expect(relativeTime(ago(59), now)).toBe('just now')
  })

  it('picks the largest unit that fits', () => {
    expect(relativeTime(ago(60), now)).toBe('1 minute ago')
    expect(relativeTime(ago(3600), now)).toBe('1 hour ago')
    expect(relativeTime(ago(86_400), now)).toBe('yesterday')
    expect(relativeTime(ago(86_400 * 7), now)).toBe('last week')
    expect(relativeTime(ago(2_592_000), now)).toBe('last month')
    expect(relativeTime(ago(31_536_000), now)).toBe('last year')
  })

  it('handles a future date without breaking', () => {
    // Clock skew between a database and a server makes this reachable.
    const future = new Date(now.getTime() + 120_000)
    expect(relativeTime(future, now)).toBe('just now')
  })
})

describe('initialsOf', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsOf('Muhammad Kashif')).toBe('MK')
    expect(initialsOf('Ada Okonkwo')).toBe('AO')
    expect(initialsOf('Tomas Anders Lindqvist')).toBe('TA')
  })

  it('copes with one name, extra spacing and nothing at all', () => {
    expect(initialsOf('Prince')).toBe('P')
    expect(initialsOf('  Jo   Fenwick  ')).toBe('JF')
    // An avatar with no letters still needs to render something.
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('   ')).toBe('?')
  })
})
