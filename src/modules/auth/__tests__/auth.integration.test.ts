import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { verifyPassword } from '@/kernel/auth/password'
import { isAppError } from '@/kernel/errors'
import { getSystemDb } from '@/lib/db'
import { setMailer, type EmailMessage } from '@/lib/email/mailer'

import * as service from '../service'

/**
 * Integration tests against a real PostgreSQL database.
 *
 * These cover what unit tests with a mocked repository cannot: the actual
 * unique constraints, enum columns and single-use token semantics, plus the
 * complete verification and reset round-trips — where the token only ever
 * exists inside the delivered email.
 *
 * Skipped automatically when no database is configured, so `npm test` still
 * passes on a machine without one. Run a local server with
 * `npm run db:start`, or let CI's Postgres service provide it.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const sent: EmailMessage[] = []
setMailer({
  send: async (message) => {
    sent.push(message)
  },
})

/** Pull the token out of the link in the most recent email. */
function tokenFromLastEmail(): string {
  const last = sent.at(-1)
  if (!last) throw new Error('No email was sent')
  const match = last.text.match(/token=([^\s&]+)/)
  if (!match?.[1]) throw new Error(`No token in email: ${last.text}`)
  return decodeURIComponent(match[1])
}

const meta = { ip: '198.51.100.7', userAgent: 'vitest-integration' }
const createdEmails: string[] = []

function uniqueEmail(label: string): string {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
  createdEmails.push(email)
  return email
}

describe.skipIf(!hasDatabase)('auth integration', () => {
  beforeEach(() => {
    sent.length = 0
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    // Clean up only the rows these tests created.
    await db.verificationToken.deleteMany({ where: { identifier: { in: createdEmails } } })
    await db.loginEvent.deleteMany({ where: { email: { in: createdEmails } } })
    await db.user.deleteMany({ where: { email: { in: createdEmails } } })
    await db.$disconnect()
  })

  describe('registration', () => {
    it('persists the user with a hashed password and an unverified address', async () => {
      const email = uniqueEmail('int-register')
      const { userId } = await service.register(
        { name: 'Ada', email, password: 'correct horse battery staple' },
        meta,
      )

      const stored = await getSystemDb().user.findUniqueOrThrow({ where: { id: userId } })
      expect(stored.email).toBe(email)
      expect(stored.emailVerifiedAt).toBeNull()
      expect(stored.status).toBe('ACTIVE')
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/)
      expect(stored.passwordHash).not.toContain('correct horse battery staple')
    })

    it('enforces email uniqueness in the database, not just in code', async () => {
      const email = uniqueEmail('int-dupe')
      await service.register({ name: 'Ada', email, password: 'a-long-enough-password' }, meta)

      await expect(
        service.register({ name: 'Other', email, password: 'another-long-password' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')

      const count = await getSystemDb().user.count({ where: { email } })
      expect(count).toBe(1)
    })
  })

  describe('sign-in', () => {
    it('authenticates and writes a successful login event', async () => {
      const email = uniqueEmail('int-signin')
      const password = 'correct horse battery staple'
      await service.register({ name: 'Ada', email, password }, meta)

      const { userId } = await service.authenticate({ email, password }, meta)

      const events = await getSystemDb().loginEvent.findMany({ where: { email } })
      expect(events.some((event) => event.success)).toBe(true)
      expect(events.every((event) => event.userId === userId || event.userId === null)).toBe(true)
    })

    it('records a failure and locks the account out after five attempts', async () => {
      const email = uniqueEmail('int-throttle')
      await service.register({ name: 'Ada', email, password: 'correct horse battery staple' }, meta)

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          service.authenticate({ email, password: 'definitely-wrong-password' }, meta),
        ).rejects.toThrow()
      }

      // The sixth attempt is rejected by the throttle, even with the RIGHT password.
      await expect(
        service.authenticate({ email, password: 'correct horse battery staple' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'RATE_LIMITED')
    })
  })

  describe('email verification round-trip', () => {
    it('verifies the address using the token from the email', async () => {
      const email = uniqueEmail('int-verify')
      const { userId } = await service.register(
        { name: 'Ada', email, password: 'correct horse battery staple' },
        meta,
      )

      await service.verifyEmail(tokenFromLastEmail(), meta)

      const stored = await getSystemDb().user.findUniqueOrThrow({ where: { id: userId } })
      expect(stored.emailVerifiedAt).toBeInstanceOf(Date)
    })

    it('refuses to reuse a verification token', async () => {
      const email = uniqueEmail('int-verify-reuse')
      await service.register({ name: 'Ada', email, password: 'correct horse battery staple' }, meta)

      const token = tokenFromLastEmail()
      await service.verifyEmail(token, meta)

      await expect(service.verifyEmail(token, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && /already been used/i.test(error.message),
      )
    })

    it('does not accept a verification token at the password-reset endpoint', async () => {
      const email = uniqueEmail('int-crosspurpose')
      await service.register({ name: 'Ada', email, password: 'correct horse battery staple' }, meta)

      const verificationToken = tokenFromLastEmail()

      await expect(
        service.resetPassword(
          { token: verificationToken, password: 'a brand new passphrase' },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })
  })

  describe('password reset round-trip', () => {
    it('replaces the password and invalidates the old one', async () => {
      const email = uniqueEmail('int-reset')
      const oldPassword = 'correct horse battery staple'
      const newPassword = 'an entirely different passphrase'

      const { userId } = await service.register({ name: 'Ada', email, password: oldPassword }, meta)

      await service.requestPasswordReset(email, meta)
      await service.resetPassword({ token: tokenFromLastEmail(), password: newPassword }, meta)

      const stored = await getSystemDb().user.findUniqueOrThrow({ where: { id: userId } })
      await expect(verifyPassword(stored.passwordHash!, newPassword)).resolves.toBe(true)
      await expect(verifyPassword(stored.passwordHash!, oldPassword)).resolves.toBe(false)
    })

    it('refuses to reuse a reset token', async () => {
      const email = uniqueEmail('int-reset-reuse')
      await service.register({ name: 'Ada', email, password: 'correct horse battery staple' }, meta)

      await service.requestPasswordReset(email, meta)
      const token = tokenFromLastEmail()

      await service.resetPassword({ token, password: 'first new passphrase here' }, meta)

      await expect(
        service.resetPassword({ token, password: 'second new passphrase here' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && /already been used/i.test(error.message))
    })

    it('sends nothing for an address that is not registered', async () => {
      await service.requestPasswordReset(uniqueEmail('int-nobody'), meta)
      expect(sent).toHaveLength(0)
    })

    it('stops issuing links after three requests in the window', async () => {
      const email = uniqueEmail('int-reset-throttle')
      await service.register({ name: 'Ada', email, password: 'correct horse battery staple' }, meta)
      sent.length = 0

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await service.requestPasswordReset(email, meta)
      }

      expect(sent.length).toBe(3)
    })
  })

  describe('audit trail', () => {
    it('records sign-up, sign-in and failures', async () => {
      const email = uniqueEmail('int-audit')
      const { userId } = await service.register(
        { name: 'Ada', email, password: 'correct horse battery staple' },
        meta,
      )

      await service.authenticate({ email, password: 'correct horse battery staple' }, meta)
      await service
        .authenticate({ email, password: 'wrong-password-entirely' }, meta)
        .catch(() => null)

      const actions = (await getSystemDb().auditLog.findMany({ where: { actorId: userId } })).map(
        (entry) => entry.action,
      )

      expect(actions).toContain('auth.signed_up')
      expect(actions).toContain('auth.signed_in')
      expect(actions).toContain('auth.sign_in_failed')
    })
  })
})
