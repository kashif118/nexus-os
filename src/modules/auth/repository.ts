import { getSystemDb, type VerificationPurpose } from '@/lib/db'

/**
 * All Prisma access for the auth module (docs/ARCHITECTURE.md §B.2).
 *
 * No authorization decisions are made here — that is the service's job. This
 * layer only knows how to read and write rows.
 *
 * Authentication is one of the sanctioned cross-tenant surfaces
 * (docs/PLATFORM.md §H.4): resolving an email address to a user necessarily
 * happens before any organization is known.
 */

export interface CreateUserInput {
  email: string
  name: string
  passwordHash: string
}

export async function findUserByEmail(email: string) {
  return getSystemDb().user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      emailVerifiedAt: true,
      status: true,
    },
  })
}

export async function findUserById(id: string) {
  return getSystemDb().user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, emailVerifiedAt: true, status: true },
  })
}

export async function createUser(input: CreateUserInput) {
  return getSystemDb().user.create({
    data: { email: input.email, name: input.name, passwordHash: input.passwordHash },
    select: { id: true, email: true, name: true },
  })
}

export async function updatePasswordHash(userId: string, passwordHash: string) {
  await getSystemDb().user.update({ where: { id: userId }, data: { passwordHash } })
}

export async function markEmailVerified(userId: string) {
  await getSystemDb().user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date() },
  })
}

/* -------------------------------------------------------------------------- */
/* Verification tokens                                                         */
/* -------------------------------------------------------------------------- */

export async function createVerificationToken(input: {
  identifier: string
  tokenHash: string
  purpose: VerificationPurpose
  expiresAt: Date
}) {
  return getSystemDb().verificationToken.create({ data: input })
}

/**
 * Look up a token, scoped to the purpose it was issued for.
 *
 * `findFirst` with both predicates rather than `findUnique` on the hash alone:
 * a token minted for email verification must be invisible to the password-reset
 * flow, so the two can never be used interchangeably.
 */
export async function findVerificationToken(tokenHash: string, purpose: VerificationPurpose) {
  return getSystemDb().verificationToken.findFirst({
    where: { tokenHash, purpose },
    select: {
      id: true,
      identifier: true,
      purpose: true,
      expiresAt: true,
      consumedAt: true,
    },
  })
}

/**
 * Consume a token, returning whether this call was the one that consumed it.
 *
 * The `consumedAt: null` predicate makes redemption atomic: two concurrent
 * requests with the same token cannot both succeed.
 */
export async function consumeVerificationToken(id: string): Promise<boolean> {
  const result = await getSystemDb().verificationToken.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  return result.count === 1
}

/** Invalidate outstanding tokens of a kind — used when a password changes. */
export async function invalidateVerificationTokens(
  identifier: string,
  purpose: VerificationPurpose,
) {
  await getSystemDb().verificationToken.updateMany({
    where: { identifier, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  })
}

export async function countRecentTokens(
  identifier: string,
  purpose: VerificationPurpose,
  since: Date,
): Promise<number> {
  return getSystemDb().verificationToken.count({
    where: { identifier, purpose, createdAt: { gte: since } },
  })
}

/* -------------------------------------------------------------------------- */
/* Login events                                                                */
/* -------------------------------------------------------------------------- */

export async function recordLoginEvent(input: {
  email: string
  success: boolean
  userId?: string | null
  reason?: string | null
  ip?: string | null
  userAgent?: string | null
}) {
  await getSystemDb().loginEvent.create({
    data: {
      email: input.email,
      success: input.success,
      userId: input.userId ?? null,
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  })
}

/** Failures since `since`, counted separately by email and by source address. */
export async function countRecentFailures(input: {
  email: string
  ip: string | null
  since: Date
}): Promise<{ emailFailures: number; ipFailures: number }> {
  const db = getSystemDb()

  const [emailFailures, ipFailures] = await Promise.all([
    db.loginEvent.count({
      where: { email: input.email, success: false, createdAt: { gte: input.since } },
    }),
    input.ip
      ? db.loginEvent.count({
          where: { ip: input.ip, success: false, createdAt: { gte: input.since } },
        })
      : Promise.resolve(0),
  ])

  return { emailFailures, ipFailures }
}

export async function listRecentLoginEvents(userId: string, limit = 10) {
  return getSystemDb().loginEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, success: true, reason: true, ip: true, userAgent: true, createdAt: true },
  })
}
