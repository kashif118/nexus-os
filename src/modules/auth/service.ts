import { writeAuditLog } from '@/kernel/audit/write'
import { fakeVerifyPassword, hashPassword, verifyPassword } from '@/kernel/auth/password'
import {
  evaluateLoginThrottle,
  LOGIN_THROTTLE,
  PASSWORD_RESET_THROTTLE,
  windowStart,
} from '@/kernel/auth/throttle'
import { generateToken, hashToken, isExpired, minutesFromNow } from '@/kernel/auth/tokens'
import { conflict, rateLimited, unauthenticated, validationError } from '@/kernel/errors'
import { absoluteUrl, getMailer } from '@/lib/email/mailer'

import * as repository from './repository'

/**
 * Authentication business rules.
 *
 * This layer owns every security decision; the transport layer (actions) only
 * validates input and maps errors. Nothing here reads cookies or touches Prisma
 * directly, which keeps it unit-testable against a mocked repository.
 *
 * Two rules run through the whole file:
 *
 * - **No account enumeration.** Sign-in and password reset behave identically
 *   whether or not the address exists, in both response and rough timing
 *   (docs/PLATFORM.md §G.5).
 * - **Every attempt is recorded.** `LoginEvent` is both the security log and the
 *   throttling source.
 */

const EMAIL_VERIFICATION_TTL_MINUTES = 60 * 24
const PASSWORD_RESET_TTL_MINUTES = 30

/** Caps user-triggered verification resends (registration is exempt). */
const EMAIL_VERIFICATION_THROTTLE = { maxRequestsPerEmail: 4, windowMinutes: 60 } as const

/** Deliberately identical for every failure mode a signed-out caller can reach. */
const INVALID_CREDENTIALS = 'That email address or password is not correct.'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export interface RegisterInput {
  name: string
  email: string
  password: string
}

/**
 * Create an account and issue an email-verification token.
 *
 * Unlike sign-in, registration *does* reveal that an address is taken — it has
 * to, or the user cannot be told why it failed. The exposure is limited: it
 * confirms registration, not a password, and is rate-limited by the same login
 * throttle upstream.
 */
export async function register(
  input: RegisterInput,
  meta: RequestMeta,
): Promise<{ userId: string }> {
  const existing = await repository.findUserByEmail(input.email)
  if (existing) {
    throw conflict('An account with that email address already exists.', {
      email: ['An account with that email address already exists.'],
    })
  }

  const passwordHash = await hashPassword(input.password)

  let user: { id: string; email: string; name: string }
  try {
    user = await repository.createUser({
      email: input.email,
      name: input.name,
      passwordHash,
    })
  } catch (error) {
    // Lost the race against a concurrent signup: the unique index is the real
    // guard, the check above is only for a friendlier message.
    if (isUniqueConstraintError(error)) {
      throw conflict('An account with that email address already exists.', {
        email: ['An account with that email address already exists.'],
      })
    }
    throw error
  }

  await sendEmailVerification(user.email)

  await writeAuditLog({
    action: 'auth.signed_up',
    entityType: 'User',
    entityId: user.id,
    actorId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { userId: user.id }
}

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                     */
/* -------------------------------------------------------------------------- */

export interface AuthenticateInput {
  email: string
  password: string
}

/**
 * Verify credentials.
 *
 * Returns the user id on success. The caller creates the session — keeping
 * cookie handling out of the service.
 */
export async function authenticate(
  input: AuthenticateInput,
  meta: RequestMeta,
): Promise<{ userId: string }> {
  const since = windowStart(LOGIN_THROTTLE.windowMinutes)
  const failures = await repository.countRecentFailures({
    email: input.email,
    ip: meta.ip,
    since,
  })

  const throttle = evaluateLoginThrottle(failures)
  if (throttle.blocked) {
    await recordFailure(input.email, null, `throttled_${throttle.reason}`, meta)
    throw rateLimited(
      'Too many sign-in attempts. Try again in a few minutes.',
      throttle.retryAfterSeconds,
    )
  }

  const user = await repository.findUserByEmail(input.email)

  // Unknown address: still pay the hashing cost so the response time does not
  // distinguish it from a wrong password.
  if (!user || !user.passwordHash) {
    await fakeVerifyPassword()
    await recordFailure(input.email, null, 'unknown_account', meta)
    throw unauthenticated(INVALID_CREDENTIALS)
  }

  const passwordValid = await verifyPassword(user.passwordHash, input.password)
  if (!passwordValid) {
    await recordFailure(input.email, user.id, 'bad_password', meta)
    throw unauthenticated(INVALID_CREDENTIALS)
  }

  if (user.status !== 'ACTIVE') {
    await recordFailure(input.email, user.id, `status_${user.status.toLowerCase()}`, meta)
    // A disabled account gets a distinct message: the caller has already proven
    // they own the credentials, so there is nothing left to enumerate.
    throw unauthenticated('This account has been disabled. Contact your administrator.')
  }

  await repository.recordLoginEvent({
    email: input.email,
    success: true,
    userId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  await writeAuditLog({
    action: 'auth.signed_in',
    entityType: 'User',
    entityId: user.id,
    actorId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { userId: user.id }
}

async function recordFailure(
  email: string,
  userId: string | null,
  reason: string,
  meta: RequestMeta,
): Promise<void> {
  await repository.recordLoginEvent({
    email,
    success: false,
    userId,
    reason,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  await writeAuditLog({
    action: 'auth.sign_in_failed',
    entityType: 'User',
    entityId: userId,
    actorId: userId,
    actorType: userId ? 'USER' : 'SYSTEM',
    metadata: { reason },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Email verification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Issue an email-verification link.
 *
 * `throttle` is off for the registration call — that one is already gated by
 * account creation — and on for user-triggered resends, which would otherwise
 * let an authenticated account send unlimited mail to its own address.
 */
export async function sendEmailVerification(
  email: string,
  options: { throttle?: boolean } = {},
): Promise<void> {
  if (options.throttle) {
    const recent = await repository.countRecentTokens(
      email,
      'EMAIL_VERIFICATION',
      windowStart(EMAIL_VERIFICATION_THROTTLE.windowMinutes),
    )
    if (recent >= EMAIL_VERIFICATION_THROTTLE.maxRequestsPerEmail) {
      throw rateLimited(
        'You have requested several confirmation emails recently. Try again later.',
        EMAIL_VERIFICATION_THROTTLE.windowMinutes * 60,
      )
    }
  }

  const token = generateToken()

  await repository.createVerificationToken({
    identifier: email,
    tokenHash: hashToken(token),
    purpose: 'EMAIL_VERIFICATION',
    expiresAt: minutesFromNow(EMAIL_VERIFICATION_TTL_MINUTES),
  })

  const url = absoluteUrl(`/verify-email?token=${encodeURIComponent(token)}`)

  await getMailer().send({
    to: email,
    subject: 'Confirm your NEXUS OS email address',
    text: `Confirm your email address to finish setting up your account:\n\n${url}\n\nThis link expires in 24 hours. If you did not create an account, ignore this message.`,
  })
}

/** Verify an email address from a token. Single-use and time-limited. */
export async function verifyEmail(token: string, meta: RequestMeta): Promise<void> {
  const record = await repository.findVerificationToken(hashToken(token), 'EMAIL_VERIFICATION')

  if (!record || record.purpose !== 'EMAIL_VERIFICATION') {
    throw validationError('That verification link is not valid.')
  }
  if (record.consumedAt !== null) {
    throw validationError('That verification link has already been used.')
  }
  if (isExpired(record.expiresAt)) {
    throw validationError('That verification link has expired. Request a new one.')
  }

  const user = await repository.findUserByEmail(record.identifier)
  if (!user) throw validationError('That verification link is not valid.')

  // Atomic redemption — a replayed link cannot verify twice.
  const consumed = await repository.consumeVerificationToken(record.id)
  if (!consumed) throw validationError('That verification link has already been used.')

  await repository.markEmailVerified(user.id)

  await writeAuditLog({
    action: 'auth.email_verified',
    entityType: 'User',
    entityId: user.id,
    actorId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Password reset                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Begin a password reset.
 *
 * Always resolves successfully, whether or not the address is registered — the
 * caller shows the same confirmation either way.
 */
export async function requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
  const recentRequests = await repository.countRecentTokens(
    email,
    'PASSWORD_RESET',
    windowStart(PASSWORD_RESET_THROTTLE.windowMinutes),
  )

  if (recentRequests >= PASSWORD_RESET_THROTTLE.maxRequestsPerEmail) {
    // Silently stop. Surfacing a rate-limit error here would confirm that the
    // address exists and is being targeted.
    return
  }

  const user = await repository.findUserByEmail(email)

  await writeAuditLog({
    action: 'auth.password_reset_requested',
    entityType: 'User',
    entityId: user?.id ?? null,
    actorId: user?.id ?? null,
    actorType: user ? 'USER' : 'SYSTEM',
    metadata: { accountExists: Boolean(user) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  if (!user) return

  const token = generateToken()
  await repository.createVerificationToken({
    identifier: email,
    tokenHash: hashToken(token),
    purpose: 'PASSWORD_RESET',
    expiresAt: minutesFromNow(PASSWORD_RESET_TTL_MINUTES),
  })

  const url = absoluteUrl(`/reset-password?token=${encodeURIComponent(token)}`)

  await getMailer().send({
    to: email,
    subject: 'Reset your NEXUS OS password',
    text: `Use this link to choose a new password:\n\n${url}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this message — your password has not changed.`,
  })
}

/**
 * Complete a password reset.
 *
 * Returns the user id so the caller can revoke sessions and sign the user in
 * with a fresh one.
 */
export async function resetPassword(
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<{ userId: string }> {
  const record = await repository.findVerificationToken(hashToken(input.token), 'PASSWORD_RESET')

  if (!record || record.purpose !== 'PASSWORD_RESET') {
    throw validationError('That reset link is not valid.')
  }
  if (record.consumedAt !== null) {
    throw validationError('That reset link has already been used.')
  }
  if (isExpired(record.expiresAt)) {
    throw validationError('That reset link has expired. Request a new one.')
  }

  const user = await repository.findUserByEmail(record.identifier)
  if (!user) throw validationError('That reset link is not valid.')

  const consumed = await repository.consumeVerificationToken(record.id)
  if (!consumed) throw validationError('That reset link has already been used.')

  await repository.updatePasswordHash(user.id, await hashPassword(input.password))

  // Any other outstanding reset link is now void.
  await repository.invalidateVerificationTokens(record.identifier, 'PASSWORD_RESET')

  await writeAuditLog({
    action: 'auth.password_reset_completed',
    entityType: 'User',
    entityId: user.id,
    actorId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { userId: user.id }
}

/* -------------------------------------------------------------------------- */

export async function getAccountOverview(userId: string) {
  const [user, loginEvents] = await Promise.all([
    repository.findUserById(userId),
    repository.listRecentLoginEvents(userId, 8),
  ])
  return { user, loginEvents }
}

/**
 * Detect a Prisma unique-constraint violation without importing Prisma here.
 *
 * The service layer must not depend on the ORM; P2002 is checked structurally.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
