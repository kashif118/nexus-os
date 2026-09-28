import { describe, expect, it } from 'vitest'

import {
  daysFromNow,
  generateToken,
  hashToken,
  isExpired,
  minutesFromNow,
  tokensMatch,
} from '../tokens'

describe('token generation', () => {
  it('returns a URL-safe string with no padding', () => {
    const token = generateToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('carries 256 bits of entropy', () => {
    // 32 bytes base64url-encoded, unpadded.
    expect(generateToken()).toHaveLength(43)
  })

  it('never repeats across a large sample', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken))
    expect(tokens.size).toBe(1000)
  })
})

describe('token hashing', () => {
  it('produces a stable sha256 hex digest', () => {
    const hash = hashToken('token-value')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('token-value')).toBe(hash)
  })

  it('does not reveal the token', () => {
    expect(hashToken('token-value')).not.toContain('token-value')
  })

  it('differs for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })
})

describe('tokensMatch', () => {
  it('matches identical digests', () => {
    expect(tokensMatch(hashToken('x'), hashToken('x'))).toBe(true)
  })

  it('rejects different digests', () => {
    expect(tokensMatch(hashToken('x'), hashToken('y'))).toBe(false)
  })

  it('rejects unequal lengths without throwing', () => {
    expect(tokensMatch('abc', 'abcdef')).toBe(false)
  })
})

describe('expiry helpers', () => {
  it('treats a past date as expired', () => {
    expect(isExpired(new Date(Date.now() - 1000))).toBe(true)
  })

  it('treats a future date as live', () => {
    expect(isExpired(minutesFromNow(5))).toBe(false)
  })

  it('treats the exact boundary as expired', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(isExpired(now, now)).toBe(true)
  })

  it('computes offsets', () => {
    const base = Date.now()
    expect(minutesFromNow(30).getTime()).toBeGreaterThanOrEqual(base + 29 * 60_000)
    expect(daysFromNow(30).getTime()).toBeGreaterThanOrEqual(base + 29 * 86_400_000)
  })
})
