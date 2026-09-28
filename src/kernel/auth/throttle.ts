/**
 * Sign-in throttling policy (docs/PLATFORM.md §G.5).
 *
 * Counts are read from `LoginEvent`, which the application already writes for
 * the security log. That means throttling needs no external store and works
 * across serverless instances — the Redis limiter in the kernel phase covers
 * general-purpose rate limiting, not this.
 *
 * The decision itself is a pure function so it can be tested exhaustively
 * without a database.
 */

export const LOGIN_THROTTLE = {
  /** Failures from one email address before it is locked out. */
  maxFailuresPerEmail: 5,
  /** Failures from one IP before it is locked out, across all addresses. */
  maxFailuresPerIp: 20,
  windowMinutes: 15,
  lockoutMinutes: 15,
} as const

export const PASSWORD_RESET_THROTTLE = {
  maxRequestsPerEmail: 3,
  windowMinutes: 60,
} as const

export interface ThrottleDecision {
  blocked: boolean
  retryAfterSeconds: number
  reason: 'email' | 'ip' | null
}

const ALLOWED: ThrottleDecision = { blocked: false, retryAfterSeconds: 0, reason: null }

/**
 * Decide whether a sign-in attempt may proceed.
 *
 * Progressive delay is expressed as a lockout that grows with the overshoot:
 * each failure past the threshold adds another minute, capped at the window.
 */
export function evaluateLoginThrottle(input: {
  emailFailures: number
  ipFailures: number
}): ThrottleDecision {
  const { emailFailures, ipFailures } = input

  if (emailFailures >= LOGIN_THROTTLE.maxFailuresPerEmail) {
    const overshoot = emailFailures - LOGIN_THROTTLE.maxFailuresPerEmail
    const minutes = Math.min(LOGIN_THROTTLE.lockoutMinutes, 1 + overshoot)
    return { blocked: true, retryAfterSeconds: minutes * 60, reason: 'email' }
  }

  if (ipFailures >= LOGIN_THROTTLE.maxFailuresPerIp) {
    return { blocked: true, retryAfterSeconds: LOGIN_THROTTLE.lockoutMinutes * 60, reason: 'ip' }
  }

  return ALLOWED
}

export function windowStart(minutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - minutes * 60_000)
}
