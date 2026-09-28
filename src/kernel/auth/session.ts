import { cookies, headers } from 'next/headers'
import { cache } from 'react'

import { getSystemDb } from '@/lib/db'
import { isProduction } from '@/kernel/config/env'

import { daysFromNow, generateToken, hashToken } from './tokens'

/**
 * Server-side session management (docs/PLATFORM.md §G.3).
 *
 * The session token lives in an httpOnly cookie and is stored only as a SHA-256
 * digest, so the cookie value is the sole bearer of the secret and the database
 * holds nothing replayable.
 *
 * ### Why not Auth.js
 * The architecture originally specified Auth.js v5 with database sessions
 * (§G.1). Auth.js cannot do both: its core asserts
 * `"Signing in with credentials only supported if JWT strategy is enabled"`,
 * so email + password forces stateless JWTs — which cannot be revoked, cannot
 * be listed as devices, and would make the Security Center a stub. Revocable
 * server-side sessions are the load-bearing requirement, so they win. Recorded
 * in docs/ROADMAP.md §U9.
 */

const SESSION_TTL_DAYS = 30

/** Sliding refresh: the row is touched at most this often (docs §G.3). */
const REFRESH_AFTER_MS = 60 * 60 * 1000

/**
 * `__Host-` requires Secure, which a plain-HTTP dev server cannot satisfy, so
 * the prefix is production-only. The prefix guarantees the cookie was set by
 * this exact origin with Path=/ and no Domain — it cannot be planted by a
 * sibling subdomain.
 */
export const SESSION_COOKIE = isProduction ? '__Host-nexus_session' : 'nexus_session'

export interface SessionUser {
  id: string
  email: string
  name: string
  image: string | null
  emailVerifiedAt: Date | null
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'
}

export interface AuthenticatedSession {
  sessionId: string
  user: SessionUser
}

/** Request metadata recorded on the session and on login events. */
export interface RequestContext {
  ip: string | null
  userAgent: string | null
}

/**
 * Best-effort client address. Values come from proxy headers and are attacker
 * controllable, so they are used for diagnostics and throttling, never for
 * authorization.
 */
export async function getRequestContext(): Promise<RequestContext> {
  const headerList = await headers()
  const forwardedFor = headerList.get('x-forwarded-for')
  const ip = forwardedFor?.split(',')[0]?.trim() ?? headerList.get('x-real-ip') ?? null

  return {
    ip: ip && ip.length > 0 ? ip.slice(0, 64) : null,
    userAgent: headerList.get('user-agent')?.slice(0, 512) ?? null,
  }
}

/**
 * Issue a new session and set the cookie.
 *
 * Always called on sign-in and after a password change, which is what makes
 * session rotation real rather than aspirational.
 */
export async function createSession(userId: string, context: RequestContext): Promise<string> {
  const token = generateToken()
  const expiresAt = daysFromNow(SESSION_TTL_DAYS)

  await getSystemDb().session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: context.ip,
      userAgent: context.userAgent,
    },
  })

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })

  return token
}

/**
 * Resolve the current session, or null.
 *
 * Memoised per request with React `cache()` so that a layout, a page and an
 * action in the same render share one database round-trip.
 */
export const getSession = cache(async (): Promise<AuthenticatedSession | null> => {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  const db = getSystemDb()
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          emailVerifiedAt: true,
          status: true,
        },
      },
    },
  })

  if (!session) return null
  if (session.revokedAt !== null) return null
  if (session.expiresAt.getTime() <= Date.now()) return null

  // A suspended or deactivated account loses access immediately, without
  // waiting for its sessions to expire.
  if (session.user.status !== 'ACTIVE') return null

  // Sliding expiry, rate-limited to one write per hour per session so that an
  // active user does not generate a database write on every request.
  if (Date.now() - session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    const expiresAt = daysFromNow(SESSION_TTL_DAYS)
    await db.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt },
    })
    await db.user.update({ where: { id: session.user.id }, data: { lastActiveAt: new Date() } })
  }

  return { sessionId: session.id, user: session.user }
})

/** Revoke the caller's current session and clear the cookie. */
export async function destroyCurrentSession(reason = 'signed_out'): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value

  if (token) {
    // updateMany, not update: an unknown token must not throw.
    await getSystemDb().session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
  }

  cookieStore.delete(SESSION_COOKIE)
}

/**
 * Revoke one session belonging to `userId`.
 *
 * Scoped by `userId` in the WHERE clause so a caller cannot revoke another
 * user's session by guessing an id.
 */
export async function revokeSession(
  userId: string,
  sessionId: string,
  reason = 'revoked_by_user',
): Promise<number> {
  const result = await getSystemDb().session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
  return result.count
}

/** Revoke every session for a user, optionally keeping one (e.g. after a password change). */
export async function revokeAllSessions(
  userId: string,
  options: { exceptSessionId?: string; reason?: string } = {},
): Promise<number> {
  const result = await getSystemDb().session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: options.reason ?? 'revoked_all' },
  })
  return result.count
}

export interface SessionSummary {
  id: string
  ip: string | null
  userAgent: string | null
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  current: boolean
}

/** Active sessions for the Security Center device list. */
export async function listActiveSessions(
  userId: string,
  currentSessionId: string,
): Promise<SessionSummary[]> {
  const sessions = await getSystemDb().session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
    },
  })

  return sessions.map((session) => ({ ...session, current: session.id === currentSessionId }))
}
