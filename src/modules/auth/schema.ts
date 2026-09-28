import { z } from 'zod'

/**
 * Authentication validation (docs/OPERATIONS.md §M.2).
 *
 * One schema per command, shared by the form and the server action. The action
 * always re-parses: client-side validation is a convenience, never a control.
 */

/**
 * Emails are normalised here — trimmed and lower-cased — so that the global
 * uniqueness constraint on `User.email` cannot be sidestepped with different
 * casing, and so a lookup never misses because of it.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .pipe(z.email('Enter a valid email address.'))

/**
 * Password policy.
 *
 * Length is the dominant factor in resisting offline cracking, so the floor is
 * 12 characters and composition rules are deliberately absent — they push people
 * toward predictable substitutions. The maximum exists because argon2 hashes the
 * whole input and an unbounded body is a cheap denial-of-service.
 *
 * A dictionary/breach check (zxcvbn or a k-anonymity lookup against a breach
 * corpus) is specified in §G.2 and is not yet implemented; `assessPasswordStrength`
 * below is the local, dependency-free part of that check.
 */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

/** Rejected outright: trivially guessable regardless of length. */
const OBVIOUS_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '123456789012',
  'qwertyuiop',
  'administrator',
  'letmein12345',
  'iloveyou1234',
  'welcome12345',
  'nexusos12345',
])

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`)
  .refine(
    (value) => !OBVIOUS_PASSWORDS.has(value.toLowerCase()),
    'That password is too easy to guess.',
  )
  .refine((value) => new Set(value).size > 4, 'That password repeats too few distinct characters.')

export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your name.')
  .max(120, 'That name is too long.')

export const signUpSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
  })
  .refine(
    (value) => !value.password.toLowerCase().includes(value.email.split('@')[0]!.toLowerCase()),
    { error: 'Your password must not contain your email address.', path: ['password'] },
  )

export const signInSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: an existing password predating a policy change must
  // still be accepted at sign-in, and echoing policy rules here would leak them.
  password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX_LENGTH),
  next: z.string().optional(),
})

export const requestPasswordResetSchema = z.object({ email: emailSchema })

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
})

export const verifyEmailSchema = z.object({ token: z.string().min(1) })

export const revokeSessionSchema = z.object({ sessionId: z.string().min(1).max(64) })

export type SignUpInput = z.infer<typeof signUpSchema>
export type SignInInput = z.infer<typeof signInSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>

/**
 * Advisory strength meter for the sign-up form.
 *
 * Purely a UI aid — the enforced rules are the schema above. It is a pure
 * function so the same scoring runs in a test.
 */
export function assessPasswordStrength(password: string): {
  score: 0 | 1 | 2 | 3 | 4
  label: string
} {
  if (password.length === 0) return { score: 0, label: 'Empty' }

  let score = 0
  if (password.length >= PASSWORD_MIN_LENGTH) score += 1
  if (password.length >= 16) score += 1
  if (new Set(password).size >= 10) score += 1
  if (/[^a-zA-Z0-9]/.test(password) || /\d/.test(password)) score += 1

  if (OBVIOUS_PASSWORDS.has(password.toLowerCase())) score = 0

  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const
  const clamped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4
  return { score: clamped, label: labels[clamped] }
}
