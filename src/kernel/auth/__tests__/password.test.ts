import { describe, expect, it } from 'vitest'

import { fakeVerifyPassword, hashPassword, verifyPassword } from '../password'

describe('password hashing', () => {
  it('produces an argon2id hash, not the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(hash).not.toContain('correct horse battery staple')
  })

  it('salts each hash, so the same password hashes differently', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password-1'),
      hashPassword('same-password-1'),
    ])
    expect(a).not.toBe(b)
  })

  it('verifies the correct password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false)
  })

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false)
    await expect(verifyPassword('', 'anything')).resolves.toBe(false)
  })

  it('exposes a timing equaliser for unknown accounts', async () => {
    await expect(fakeVerifyPassword()).resolves.toBeUndefined()
  })
})
