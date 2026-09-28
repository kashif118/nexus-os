import { describe, expect, it } from 'vitest'

import {
  assessPasswordStrength,
  emailSchema,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  signInSchema,
  signUpSchema,
} from '../schema'

describe('emailSchema', () => {
  it('normalises casing and surrounding whitespace', () => {
    expect(emailSchema.parse('  Ada.Lovelace@Example.COM  ')).toBe('ada.lovelace@example.com')
  })

  it('rejects malformed addresses', () => {
    for (const value of ['', 'not-an-email', 'a@', '@b.com', 'a b@c.com']) {
      expect(emailSchema.safeParse(value).success).toBe(false)
    }
  })

  it('rejects an address beyond the length limit', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false)
  })
})

describe('passwordSchema', () => {
  it('accepts a long passphrase', () => {
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true)
  })

  it('rejects anything shorter than the minimum', () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false)
  })

  it('rejects an unbounded password, which would be a hashing DoS', () => {
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false)
  })

  it('rejects well-known passwords regardless of length', () => {
    expect(passwordSchema.safeParse('password123').success).toBe(false)
    expect(passwordSchema.safeParse('PASSWORD123').success).toBe(false)
  })

  it('rejects a long string of too few distinct characters', () => {
    expect(passwordSchema.safeParse('ababababababab').success).toBe(false)
  })
})

describe('signUpSchema', () => {
  const valid = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    password: 'analytical engine 1843',
  }

  it('accepts a valid registration', () => {
    const parsed = signUpSchema.parse(valid)
    expect(parsed.email).toBe('ada@example.com')
  })

  it('refuses a password containing the email local part', () => {
    const result = signUpSchema.safeParse({ ...valid, password: 'ada-is-my-password' })
    expect(result.success).toBe(false)
  })

  it('reports the email-in-password problem against the password field', () => {
    const result = signUpSchema.safeParse({ ...valid, password: 'ada-is-my-password' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['password'])
    }
  })

  it('requires a name', () => {
    expect(signUpSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false)
  })
})

describe('signInSchema', () => {
  it('does not apply the password policy to sign-in', () => {
    // A password set before a policy change must still be accepted.
    const result = signInSchema.safeParse({ email: 'ada@example.com', password: 'short' })
    expect(result.success).toBe(true)
  })

  it('still requires a password to be present', () => {
    expect(signInSchema.safeParse({ email: 'ada@example.com', password: '' }).success).toBe(false)
  })
})

describe('assessPasswordStrength', () => {
  it('scores an empty password as zero', () => {
    expect(assessPasswordStrength('').score).toBe(0)
  })

  it('scores a known-bad password as zero even when long', () => {
    expect(assessPasswordStrength('password123').score).toBe(0)
  })

  it('rates a long, varied passphrase highly', () => {
    expect(assessPasswordStrength('correct-horse-battery-staple-42').score).toBe(4)
  })

  it('never exceeds the scale', () => {
    expect(assessPasswordStrength('x'.repeat(200)).score).toBeLessThanOrEqual(4)
  })
})
