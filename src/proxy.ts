import { NextResponse, type NextRequest } from 'next/server'

/**
 * Edge proxy — the file convention Next.js 16 renamed from `middleware`
 * (docs/PLATFORM.md §G.4).
 *
 * This is a CONVENIENCE, not a security control. It runs on the edge runtime
 * where Prisma is unavailable, so it can only observe that a session cookie is
 * *present* — it cannot tell whether that cookie names a live, unrevoked session
 * belonging to an active user.
 *
 * The real check is `requireUserPage()` in `(app)/layout.tsx` and `requireUser()`
 * in every action, both of which hit the database. Forging this cookie gets an
 * attacker exactly as far as a redirect into a page that then rejects them.
 *
 * Its job is to save a round-trip: send an obviously signed-out visitor to
 * sign-in without rendering a protected layout first.
 *
 * The org-slug resolution and per-request CSP nonce described in §G.4 and §N.1
 * join this file in the multi-tenancy and kernel phases.
 */

// Must match `SESSION_COOKIE` in kernel/auth/session.ts. Duplicated because the
// edge bundle cannot import a module that pulls in the database client.
const SESSION_COOKIE_NAMES = ['__Host-nexus_session', 'nexus_session'] as const

/**
 * Routes reachable while signed out. Everything else — including every
 * /{orgSlug}/... path, whose slugs cannot be enumerated here — is treated as
 * protected and redirected early.
 */
const PUBLIC_PATHS = new Set([
  '/',
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
])

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => request.cookies.get(name)?.value)
  if (hasSessionCookie) return NextResponse.next()

  // An API route answers in JSON, so a signed-out caller gets 401 rather than a
  // redirect to an HTML sign-in page. Redirecting here is worse than useless: a
  // fetch follows it and reports success, so the caller sees a 200 carrying
  // markup instead of the failure that actually happened.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
  }

  const signIn = new URL('/sign-in', request.url)
  signIn.searchParams.set('next', pathname)
  return NextResponse.redirect(signIn)
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. Keeping the matcher
     * narrow keeps middleware off the hot path for assets.
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
}
