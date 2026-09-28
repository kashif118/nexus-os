import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashPassword } from '@/kernel/auth/password'
import { hashToken } from '@/kernel/auth/tokens'
import { isAppError } from '@/kernel/errors'

vi.mock('../repository')
vi.mock('@/kernel/audit/write', () => ({ writeAuditLog: vi.fn(async () => {}) }))

const sentEmails: Array<{ to: string; subject: string; text: string }> = []
vi.mock('@/lib/email/mailer', () => ({
  getMailer: () => ({
    send: async (message: { to: string; subject: string; text: string }) => {
      sentEmails.push(message)
    },
  }),
  absoluteUrl: (path: string) => `http://localhost:3000${path}`,
}))

import * as repository from '../repository'
import * as service from '../service'

const meta = { ip: '203.0.113.4', userAgent: 'vitest' }
const mocked = vi.mocked(repository)

/** Default: nothing exists, nothing is throttled. */
function resetRepository() {
  vi.resetAllMocks()
  sentEmails.length = 0
  mocked.findUserByEmail.mockResolvedValue(null)
  mocked.countRecentFailures.mockResolvedValue({ emailFailures: 0, ipFailures: 0 })
  mocked.countRecentTokens.mockResolvedValue(0)
  mocked.recordLoginEvent.mockResolvedValue(undefined)
  mocked.createVerificationToken.mockResolvedValue({} as never)
  mocked.consumeVerificationToken.mockResolvedValue(true)
  mocked.updatePasswordHash.mockResolvedValue(undefined)
  mocked.invalidateVerificationTokens.mockResolvedValue(undefined)
  mocked.markEmailVerified.mockResolvedValue(undefined)
}

beforeEach(resetRepository)

async function activeUser(password = 'correct horse battery staple') {
  return {
    id: 'user_1',
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: await hashPassword(password),
    emailVerifiedAt: null,
    status: 'ACTIVE' as const,
  }
}

describe('register', () => {
  it('creates the user and sends a verification email', async () => {
    mocked.createUser.mockResolvedValue({ id: 'user_1', email: 'ada@example.com', name: 'Ada' })

    const result = await service.register(
      { name: 'Ada', email: 'ada@example.com', password: 'analytical engine 1843' },
      meta,
    )

    expect(result.userId).toBe('user_1')
    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0]?.to).toBe('ada@example.com')
  })

  it('stores a hash, never the password', async () => {
    mocked.createUser.mockResolvedValue({ id: 'user_1', email: 'ada@example.com', name: 'Ada' })

    await service.register(
      { name: 'Ada', email: 'ada@example.com', password: 'analytical engine 1843' },
      meta,
    )

    const passed = mocked.createUser.mock.calls[0]?.[0]
    expect(passed?.passwordHash).toMatch(/^\$argon2id\$/)
    expect(JSON.stringify(passed)).not.toContain('analytical engine 1843')
  })

  it('stores only the token hash, never the raw token', async () => {
    mocked.createUser.mockResolvedValue({ id: 'user_1', email: 'ada@example.com', name: 'Ada' })

    await service.register(
      { name: 'Ada', email: 'ada@example.com', password: 'analytical engine 1843' },
      meta,
    )

    const stored = mocked.createVerificationToken.mock.calls[0]?.[0]
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    const linkToken = sentEmails[0]?.text.match(/token=([^\s&]+)/)?.[1]
    expect(linkToken).toBeDefined()
    expect(stored?.tokenHash).toBe(hashToken(decodeURIComponent(linkToken!)))
  })

  it('rejects an address that is already registered', async () => {
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    await expect(
      service.register(
        { name: 'Ada', email: 'ada@example.com', password: 'a-long-password-1' },
        meta,
      ),
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')
  })

  it('translates a lost unique-constraint race into a conflict', async () => {
    mocked.createUser.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))

    await expect(
      service.register(
        { name: 'Ada', email: 'ada@example.com', password: 'a-long-password-1' },
        meta,
      ),
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')
  })
})

describe('authenticate', () => {
  it('accepts correct credentials', async () => {
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    const result = await service.authenticate(
      { email: 'ada@example.com', password: 'correct horse battery staple' },
      meta,
    )

    expect(result.userId).toBe('user_1')
    expect(mocked.recordLoginEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, userId: 'user_1' }),
    )
  })

  it('rejects a wrong password', async () => {
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    await expect(
      service.authenticate({ email: 'ada@example.com', password: 'wrong-password-here' }, meta),
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'UNAUTHENTICATED')
  })

  it('gives an unknown account the identical message to a wrong password', async () => {
    const known = await activeUser()

    mocked.findUserByEmail.mockResolvedValue(null)
    const unknownError = await service
      .authenticate({ email: 'nobody@example.com', password: 'whatever-password' }, meta)
      .catch((error: unknown) => error)

    mocked.findUserByEmail.mockResolvedValue(known)
    const wrongPasswordError = await service
      .authenticate({ email: 'ada@example.com', password: 'whatever-password' }, meta)
      .catch((error: unknown) => error)

    expect(isAppError(unknownError) && unknownError.message).toBe(
      isAppError(wrongPasswordError) && wrongPasswordError.message,
    )
  })

  it('records a failure for an unknown address, so attacks on it are throttled', async () => {
    await service
      .authenticate({ email: 'nobody@example.com', password: 'whatever-password' }, meta)
      .catch(() => null)

    expect(mocked.recordLoginEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, reason: 'unknown_account' }),
    )
  })

  it('refuses a suspended account even with the right password', async () => {
    mocked.findUserByEmail.mockResolvedValue({ ...(await activeUser()), status: 'SUSPENDED' })

    await expect(
      service.authenticate(
        { email: 'ada@example.com', password: 'correct horse battery staple' },
        meta,
      ),
    ).rejects.toSatisfy((error) => isAppError(error) && /disabled/i.test(error.message))
  })

  it('refuses an account with no password set', async () => {
    mocked.findUserByEmail.mockResolvedValue({ ...(await activeUser()), passwordHash: null })

    await expect(
      service.authenticate({ email: 'ada@example.com', password: 'anything-at-all' }, meta),
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'UNAUTHENTICATED')
  })

  it('blocks once the throttle threshold is reached, before checking the password', async () => {
    mocked.countRecentFailures.mockResolvedValue({ emailFailures: 5, ipFailures: 0 })

    await expect(
      service.authenticate(
        { email: 'ada@example.com', password: 'correct horse battery staple' },
        meta,
      ),
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'RATE_LIMITED')

    expect(mocked.findUserByEmail).not.toHaveBeenCalled()
  })
})

describe('requestPasswordReset', () => {
  it('sends a link when the account exists', async () => {
    mocked.findUserByEmail.mockResolvedValue(await activeUser())
    await service.requestPasswordReset('ada@example.com', meta)
    expect(sentEmails).toHaveLength(1)
  })

  it('stays silent for an unknown address and sends nothing', async () => {
    await expect(service.requestPasswordReset('nobody@example.com', meta)).resolves.toBeUndefined()
    expect(sentEmails).toHaveLength(0)
    expect(mocked.createVerificationToken).not.toHaveBeenCalled()
  })

  it('stops after too many requests without revealing that it did', async () => {
    mocked.findUserByEmail.mockResolvedValue(await activeUser())
    mocked.countRecentTokens.mockResolvedValue(3)

    await expect(service.requestPasswordReset('ada@example.com', meta)).resolves.toBeUndefined()
    expect(sentEmails).toHaveLength(0)
  })
})

describe('resetPassword', () => {
  const token = 'reset-token'

  function tokenRecord(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'token_1',
      identifier: 'ada@example.com',
      purpose: 'PASSWORD_RESET' as const,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      ...overrides,
    }
  }

  it('sets a new password hash', async () => {
    mocked.findVerificationToken.mockResolvedValue(tokenRecord() as never)
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    const result = await service.resetPassword({ token, password: 'a brand new passphrase' }, meta)

    expect(result.userId).toBe('user_1')
    const [, newHash] = mocked.updatePasswordHash.mock.calls[0] ?? []
    expect(newHash).toMatch(/^\$argon2id\$/)
  })

  it('rejects an expired token', async () => {
    mocked.findVerificationToken.mockResolvedValue(
      tokenRecord({ expiresAt: new Date(Date.now() - 1000) }) as never,
    )
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    await expect(
      service.resetPassword({ token, password: 'a brand new passphrase' }, meta),
    ).rejects.toSatisfy((error) => isAppError(error) && /expired/i.test(error.message))
  })

  it('rejects a token that was already used', async () => {
    mocked.findVerificationToken.mockResolvedValue(tokenRecord({ consumedAt: new Date() }) as never)

    await expect(
      service.resetPassword({ token, password: 'a brand new passphrase' }, meta),
    ).rejects.toSatisfy((error) => isAppError(error) && /already been used/i.test(error.message))
  })

  it('rejects an unknown token', async () => {
    mocked.findVerificationToken.mockResolvedValue(null)

    await expect(
      service.resetPassword({ token, password: 'a brand new passphrase' }, meta),
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
  })

  it('loses a concurrent redemption race rather than resetting twice', async () => {
    mocked.findVerificationToken.mockResolvedValue(tokenRecord() as never)
    mocked.findUserByEmail.mockResolvedValue(await activeUser())
    mocked.consumeVerificationToken.mockResolvedValue(false)

    await expect(
      service.resetPassword({ token, password: 'a brand new passphrase' }, meta),
    ).rejects.toSatisfy((error) => isAppError(error) && /already been used/i.test(error.message))
    expect(mocked.updatePasswordHash).not.toHaveBeenCalled()
  })

  it('invalidates other outstanding reset tokens', async () => {
    mocked.findVerificationToken.mockResolvedValue(tokenRecord() as never)
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    await service.resetPassword({ token, password: 'a brand new passphrase' }, meta)

    expect(mocked.invalidateVerificationTokens).toHaveBeenCalledWith(
      'ada@example.com',
      'PASSWORD_RESET',
    )
  })
})

describe('verifyEmail', () => {
  it('marks the address verified', async () => {
    mocked.findVerificationToken.mockResolvedValue({
      id: 'token_1',
      identifier: 'ada@example.com',
      purpose: 'EMAIL_VERIFICATION',
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    } as never)
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    await service.verifyEmail('token', meta)
    expect(mocked.markEmailVerified).toHaveBeenCalledWith('user_1')
  })

  it('refuses a token issued for a password reset', async () => {
    // The lookup is already scoped by purpose; this asserts the service does not
    // rely on that alone.
    mocked.findVerificationToken.mockResolvedValue({
      id: 'token_1',
      identifier: 'ada@example.com',
      purpose: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    } as never)

    await expect(service.verifyEmail('token', meta)).rejects.toSatisfy(
      (error) => isAppError(error) && error.code === 'VALIDATION_ERROR',
    )
    expect(mocked.markEmailVerified).not.toHaveBeenCalled()
  })

  it('refuses an expired link', async () => {
    mocked.findVerificationToken.mockResolvedValue({
      id: 'token_1',
      identifier: 'ada@example.com',
      purpose: 'EMAIL_VERIFICATION',
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    } as never)
    mocked.findUserByEmail.mockResolvedValue(await activeUser())

    await expect(service.verifyEmail('token', meta)).rejects.toSatisfy(
      (error) => isAppError(error) && /expired/i.test(error.message),
    )
  })
})
