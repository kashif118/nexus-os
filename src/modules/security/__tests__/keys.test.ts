import { describe, expect, it } from 'vitest'

import { apiKeyMatches, generateApiKey, hashApiKey, looksLikeApiKey, readApiKey } from '../keys'
import { ipAllowed, isCidr } from '../service'

describe('generateApiKey', () => {
  it('produces a prefixed key with a recognisable shape', () => {
    const key = generateApiKey()

    expect(key.plaintext.startsWith('nxs_')).toBe(true)
    expect(looksLikeApiKey(key.plaintext)).toBe(true)
    expect(key.prefix).toBe(key.plaintext.slice(0, 11))
  })

  it('never returns the same key twice', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().plaintext))
    expect(keys.size).toBe(200)
  })

  it('stores a digest, not the key', () => {
    const key = generateApiKey()

    expect(key.tokenHash).not.toContain(key.plaintext)
    expect(key.tokenHash).toHaveLength(64)
    expect(key.tokenHash).toBe(hashApiKey(key.plaintext))
  })

  it('has a prefix too short to be useful to an attacker', () => {
    const key = generateApiKey()
    // Four characters of the secret. The remaining entropy is ~250 bits.
    expect(key.prefix.length).toBeLessThan(key.plaintext.length / 3)
  })
})

describe('apiKeyMatches', () => {
  it('accepts the right key and rejects a wrong one', () => {
    const key = generateApiKey()
    const other = generateApiKey()

    expect(apiKeyMatches(key.plaintext, key.tokenHash)).toBe(true)
    expect(apiKeyMatches(other.plaintext, key.tokenHash)).toBe(false)
  })

  it('rejects a near-miss', () => {
    const key = generateApiKey()
    const tampered = `${key.plaintext.slice(0, -1)}X`
    expect(apiKeyMatches(tampered, key.tokenHash)).toBe(false)
  })

  it('does not throw on a malformed stored hash', () => {
    const key = generateApiKey()
    expect(() => apiKeyMatches(key.plaintext, 'nonsense')).not.toThrow()
    expect(apiKeyMatches(key.plaintext, 'nonsense')).toBe(false)
  })
})

describe('readApiKey', () => {
  it('reads a bearer token', () => {
    const key = generateApiKey()
    const headers = new Headers({ authorization: `Bearer ${key.plaintext}` })
    expect(readApiKey(headers)).toBe(key.plaintext)
  })

  it('reads the X-API-Key header', () => {
    const key = generateApiKey()
    const headers = new Headers({ 'x-api-key': key.plaintext })
    expect(readApiKey(headers)).toBe(key.plaintext)
  })

  it('ignores anything that is not shaped like one of our keys', () => {
    expect(readApiKey(new Headers({ authorization: 'Bearer abc' }))).toBeNull()
    expect(readApiKey(new Headers({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull()
    expect(readApiKey(new Headers())).toBeNull()
  })
})

describe('isCidr', () => {
  it('accepts valid IPv4 ranges', () => {
    expect(isCidr('203.0.113.0/24')).toBe(true)
    expect(isCidr('10.0.0.0/8')).toBe(true)
    expect(isCidr('192.168.1.1/32')).toBe(true)
  })

  it('rejects anything it could not actually enforce', () => {
    expect(isCidr('203.0.113.0')).toBe(false)
    expect(isCidr('999.0.0.0/24')).toBe(false)
    expect(isCidr('203.0.113.0/33')).toBe(false)
    // IPv6 is refused rather than silently accepted and never matched.
    expect(isCidr('2001:db8::/32')).toBe(false)
    expect(isCidr('')).toBe(false)
  })
})

describe('ipAllowed', () => {
  it('allows everything when no ranges are configured', () => {
    expect(ipAllowed('203.0.113.5', [])).toBe(true)
    expect(ipAllowed(null, [])).toBe(true)
  })

  it('matches inside a range and rejects outside it', () => {
    expect(ipAllowed('203.0.113.5', ['203.0.113.0/24'])).toBe(true)
    expect(ipAllowed('203.0.114.5', ['203.0.113.0/24'])).toBe(false)
  })

  it('handles an exact host and a whole-internet range', () => {
    expect(ipAllowed('192.168.1.1', ['192.168.1.1/32'])).toBe(true)
    expect(ipAllowed('192.168.1.2', ['192.168.1.1/32'])).toBe(false)
    expect(ipAllowed('8.8.8.8', ['0.0.0.0/0'])).toBe(true)
  })

  it('refuses an unknown address when an allowlist is configured', () => {
    // An allowlist that fails open is not an allowlist.
    expect(ipAllowed(null, ['203.0.113.0/24'])).toBe(false)
  })

  it('refuses a malformed address rather than matching it', () => {
    expect(ipAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false)
    expect(ipAllowed('203.0.113', ['203.0.113.0/24'])).toBe(false)
  })

  it('matches against any of several ranges', () => {
    const ranges = ['10.0.0.0/8', '203.0.113.0/24']
    expect(ipAllowed('10.1.2.3', ranges)).toBe(true)
    expect(ipAllowed('203.0.113.9', ranges)).toBe(true)
    expect(ipAllowed('8.8.8.8', ranges)).toBe(false)
  })
})
