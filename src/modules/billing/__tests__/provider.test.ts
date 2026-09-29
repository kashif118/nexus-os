import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { entitledPlan, formatBytes, formatLimit, isPlanKey, planFor, PLANS } from '../plans'
import { verifyStripeSignature } from '../provider'

const SECRET = 'whsec_test_secret_value_1234567890'

function sign(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' })

  it('accepts a correctly signed payload', () => {
    expect(verifyStripeSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('rejects a payload signed with the wrong secret', () => {
    // Without this check, anybody who found the endpoint could declare any
    // subscription active.
    expect(verifyStripeSignature(body, sign(body, 'whsec_wrong_secret_aaaaaaa'), SECRET)).toBe(
      false,
    )
  })

  it('rejects a tampered body', () => {
    const header = sign(body)
    const tampered = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.deleted' })

    expect(verifyStripeSignature(tampered, header, SECRET)).toBe(false)
  })

  it('rejects a missing or malformed header', () => {
    expect(verifyStripeSignature(body, null, SECRET)).toBe(false)
    expect(verifyStripeSignature(body, '', SECRET)).toBe(false)
    expect(verifyStripeSignature(body, 'nonsense', SECRET)).toBe(false)
    expect(verifyStripeSignature(body, 't=123', SECRET)).toBe(false)
  })

  it('rejects an empty secret rather than accepting everything', () => {
    expect(verifyStripeSignature(body, sign(body, ''), '')).toBe(false)
  })

  it('rejects a replay outside the tolerance window', () => {
    const old = Math.floor(Date.now() / 1000) - 3_600
    const header = sign(body, SECRET, old)

    // The signature is genuine; the timestamp is not recent. A captured,
    // correctly-signed request must not be replayable a week later.
    expect(verifyStripeSignature(body, header, SECRET)).toBe(false)
  })

  it('accepts within the tolerance window', () => {
    const recent = Math.floor(Date.now() / 1000) - 60
    expect(verifyStripeSignature(body, sign(body, SECRET, recent), SECRET)).toBe(true)
  })

  it('accepts when any of several signatures matches', () => {
    // During a secret rotation the provider sends more than one v1 value.
    const timestamp = Math.floor(Date.now() / 1000)
    const good = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')
    const header = `t=${timestamp},v1=deadbeef,v1=${good}`

    expect(verifyStripeSignature(body, header, SECRET)).toBe(true)
  })

  it('does not throw on a signature of the wrong length', () => {
    const timestamp = Math.floor(Date.now() / 1000)
    // `timingSafeEqual` throws on a length mismatch, and a thrown error would
    // itself be a signal.
    expect(() => verifyStripeSignature(body, `t=${timestamp},v1=ab`, SECRET)).not.toThrow()
    expect(verifyStripeSignature(body, `t=${timestamp},v1=ab`, SECRET)).toBe(false)
  })
})

describe('plans', () => {
  it('recognises the plans it defines', () => {
    expect(isPlanKey('free')).toBe(true)
    expect(isPlanKey('team')).toBe(true)
    expect(isPlanKey('enterprise')).toBe(false)
  })

  it('falls back to free for an unknown plan, never to unlimited', () => {
    // Failing open on an entitlement check is how a limit stops being a limit.
    expect(planFor('nonsense').key).toBe('free')
    expect(planFor(null).key).toBe('free')
    expect(planFor(undefined).key).toBe('free')
  })

  it('entitles a paid plan only while the status supports it', () => {
    expect(entitledPlan('business', 'ACTIVE').key).toBe('business')
    expect(entitledPlan('business', 'TRIALING').key).toBe('business')
    // A failed payment does not take away access to your own data mid-month.
    expect(entitledPlan('business', 'PAST_DUE').key).toBe('business')
    expect(entitledPlan('business', 'CANCELED').key).toBe('free')
    expect(entitledPlan('business', 'NONE').key).toBe('free')
    expect(entitledPlan('business', null).key).toBe('free')
  })

  it('has strictly increasing limits up the tiers', () => {
    expect(PLANS.team.limits.seats).toBeGreaterThan(PLANS.free.limits.seats)
    expect(PLANS.business.limits.seats).toBeGreaterThan(PLANS.team.limits.seats)
    expect(PLANS.team.limits.storageBytes).toBeGreaterThan(PLANS.free.limits.storageBytes)
  })

  it('formats limits and sizes readably', () => {
    expect(formatLimit(25)).toBe('25')
    expect(formatLimit(Infinity)).toBe('unlimited')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
    expect(formatBytes(Infinity)).toBe('unlimited')
  })
})
