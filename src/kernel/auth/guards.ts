import { redirect } from 'next/navigation'

import { unauthenticated } from '@/kernel/errors'

import { getSession, type AuthenticatedSession, type SessionUser } from './session'

/**
 * Access guards (docs/PLATFORM.md §G.4).
 *
 * These are the ONLY sanctioned way for a page, layout or action to learn who is
 * calling. UI-level checks are cosmetic; every one of these runs on the server.
 *
 * Organization membership, roles and permissions join this path in the
 * multi-tenancy and RBAC phases, at which point `requireCtx()` supersedes
 * `requireUser()` for tenant-scoped screens. The shape is deliberately
 * compatible: a Ctx is this plus org and permissions.
 */

/** The current user, or null. Use when both states are legitimate. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getSession()
  return session?.user ?? null
}

/**
 * Require an authenticated caller inside a Server Action.
 *
 * Throws rather than redirects: an action returns a typed error result, and
 * redirecting from an action would swallow the failure.
 */
export async function requireUser(): Promise<AuthenticatedSession> {
  const session = await getSession()
  if (!session) throw unauthenticated()
  return session
}

/**
 * Require an authenticated caller inside a page or layout, redirecting to
 * sign-in otherwise.
 *
 * `next` carries the requested path so the user lands where they were going.
 * It is validated on the way back out (see `safeRedirectPath`) to prevent an
 * open redirect.
 */
export async function requireUserPage(returnTo?: string): Promise<AuthenticatedSession> {
  const session = await getSession()
  if (!session) {
    const target = returnTo ? `/sign-in?next=${encodeURIComponent(returnTo)}` : '/sign-in'
    redirect(target)
  }
  return session
}

/** Redirect an already-authenticated visitor away from sign-in/sign-up. */
export async function requireGuest(destination = '/account'): Promise<void> {
  const session = await getSession()
  if (session) redirect(destination)
}

/**
 * Only same-origin, absolute-path redirects are allowed.
 *
 * Rejects `https://evil.test`, protocol-relative `//evil.test` and anything with
 * a backslash, which some browsers normalise to a forward slash.
 */
export function safeRedirectPath(candidate: string | null | undefined, fallback = '/account') {
  if (!candidate) return fallback
  if (!candidate.startsWith('/')) return fallback
  if (candidate.startsWith('//')) return fallback
  if (/\\/.test(candidate)) return fallback
  return candidate
}
