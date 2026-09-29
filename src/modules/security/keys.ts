import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * API key generation and verification — pure, and tested.
 *
 * The same shape as the session token design: 256 bits of entropy, stored only
 * as a SHA-256 digest, with the plaintext existing exactly once in the response
 * that created it. A database leak therefore yields no usable credential.
 *
 * No key derivation function here, and that is deliberate rather than an
 * oversight. Argon2 protects a LOW-entropy secret — a password somebody chose —
 * against offline guessing. A 256-bit random token cannot be guessed, so a slow
 * hash would add latency to every API request and buy nothing. The property
 * that matters is that the stored value is not the credential, which SHA-256
 * gives.
 */

const PREFIX = 'nxs'
const TOKEN_BYTES = 32

export interface GeneratedKey {
  /** Shown once. Never stored, never recoverable. */
  plaintext: string
  /** Stored, and shown in listings so keys can be told apart. */
  prefix: string
  tokenHash: string
}

export function generateApiKey(): GeneratedKey {
  const secret = randomBytes(TOKEN_BYTES).toString('base64url')
  const plaintext = `${PREFIX}_${secret}`

  return {
    plaintext,
    // Enough to distinguish keys in a list, far too little to brute-force from.
    prefix: plaintext.slice(0, 11),
    tokenHash: hashApiKey(plaintext),
  }
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

/**
 * Compare a presented key against a stored digest, in constant time.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak, so
 * both sides are hashed first and are therefore always the same length.
 */
export function apiKeyMatches(plaintext: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(plaintext), 'hex')
  const stored = Buffer.from(storedHash, 'hex')

  if (presented.length !== stored.length) return false
  return timingSafeEqual(presented, stored)
}

/** Recognise something that is shaped like one of our keys. */
export function looksLikeApiKey(value: string): boolean {
  return /^nxs_[A-Za-z0-9_-]{40,}$/.test(value)
}

/**
 * Extract a key from a request's headers.
 *
 * Accepts `Authorization: Bearer …` and `X-API-Key`. A key in a QUERY STRING is
 * deliberately not accepted: query strings end up in server logs, browser
 * history and referrer headers, and a credential that leaks into a log is a
 * credential that has to be rotated.
 */
export function readApiKey(headers: Headers): string | null {
  const bearer = headers.get('authorization')
  if (bearer?.toLowerCase().startsWith('bearer ')) {
    const value = bearer.slice(7).trim()
    if (looksLikeApiKey(value)) return value
  }

  const header = headers.get('x-api-key')?.trim()
  if (header && looksLikeApiKey(header)) return header

  return null
}
