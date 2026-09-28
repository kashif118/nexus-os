import { describe, expect, it } from 'vitest'

import { evaluateLoginThrottle, LOGIN_THROTTLE, windowStart } from '../throttle'

describe('evaluateLoginThrottle', () => {
  it('allows an attempt with no failures', () => {
    expect(evaluateLoginThrottle({ emailFailures: 0, ipFailures: 0 })).toEqual({
      blocked: false,
      retryAfterSeconds: 0,
      reason: null,
    })
  })

  it('allows attempts below the email threshold', () => {
    const result = evaluateLoginThrottle({
      emailFailures: LOGIN_THROTTLE.maxFailuresPerEmail - 1,
      ipFailures: 0,
    })
    expect(result.blocked).toBe(false)
  })

  it('blocks at the email threshold', () => {
    const result = evaluateLoginThrottle({
      emailFailures: LOGIN_THROTTLE.maxFailuresPerEmail,
      ipFailures: 0,
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('email')
    expect(result.retryAfterSeconds).toBe(60)
  })

  it('backs off progressively as failures mount', () => {
    const first = evaluateLoginThrottle({ emailFailures: 5, ipFailures: 0 })
    const later = evaluateLoginThrottle({ emailFailures: 9, ipFailures: 0 })
    expect(later.retryAfterSeconds).toBeGreaterThan(first.retryAfterSeconds)
  })

  it('caps the lockout at the configured maximum', () => {
    const result = evaluateLoginThrottle({ emailFailures: 500, ipFailures: 0 })
    expect(result.retryAfterSeconds).toBe(LOGIN_THROTTLE.lockoutMinutes * 60)
  })

  it('blocks a noisy address even when one email is clean', () => {
    const result = evaluateLoginThrottle({
      emailFailures: 0,
      ipFailures: LOGIN_THROTTLE.maxFailuresPerIp,
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('ip')
  })

  it('reports the email reason first when both thresholds are crossed', () => {
    const result = evaluateLoginThrottle({ emailFailures: 99, ipFailures: 99 })
    expect(result.reason).toBe('email')
  })
})

describe('windowStart', () => {
  it('subtracts the window from the reference time', () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    expect(windowStart(15, now).toISOString()).toBe('2026-01-01T11:45:00.000Z')
  })
})
