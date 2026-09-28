import { hash, verify } from '@node-rs/argon2'

/**
 * Password hashing (docs/PLATFORM.md §G.2).
 *
 * argon2id — memory-hard, so GPU cracking gains far less than it does against
 * bcrypt/PBKDF2. `@node-rs/argon2` is used rather than the `argon2` package
 * because it ships prebuilt binaries and needs no native toolchain on Windows or
 * in the Vercel build image.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's argon2id baseline
 * (19 MiB, 2 iterations, parallelism 1). They are recorded inside the encoded
 * hash, so raising them later does not invalidate existing passwords.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS)
}

/**
 * Verify a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed hash: a corrupt row must
 * fail the sign-in, not surface a 500 that distinguishes it from a wrong
 * password.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS)
  } catch {
    return false
  }
}

/**
 * Burn roughly the same CPU as a real verification.
 *
 * Sign-in must not be measurably faster for an unknown email than for a known
 * one, or the endpoint becomes an account-enumeration oracle
 * (docs/PLATFORM.md §G.5).
 */
export async function fakeVerifyPassword(): Promise<void> {
  await hash('nexus-os-timing-equaliser', ARGON2_OPTIONS)
}
