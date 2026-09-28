import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque token generation and storage.
 *
 * Session tokens, email-verification tokens and password-reset tokens are all
 * high-entropy random strings. Only their SHA-256 digest is persisted, so a
 * database leak yields nothing replayable.
 *
 * SHA-256 rather than argon2 here is deliberate and correct: these tokens are
 * 256 bits of uniform randomness, so there is no low-entropy secret to protect
 * against brute force — and lookup must be a single indexed query per request.
 */

/** 32 bytes = 256 bits of entropy, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time comparison of two hex digests of equal length. */
export function tokensMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}

export const minutesFromNow = (minutes: number): Date => new Date(Date.now() + minutes * 60_000)

export const daysFromNow = (days: number): Date => new Date(Date.now() + days * 86_400_000)

export const isExpired = (expiresAt: Date, now: Date = new Date()): boolean =>
  expiresAt.getTime() <= now.getTime()
