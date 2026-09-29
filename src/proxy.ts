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
 * It is also where the per-request CSP nonce is minted (docs/OPERATIONS.md
 * §N.1), because a nonce must be unpredictable and generated once per response.
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

/**
 * Endpoints that carry their own credential and therefore must not be judged on
 * a session cookie.
 *
 * A payment provider posting a webhook has no cookie and never will; neither
 * does a scheduler, nor an uptime monitor, nor a caller holding an API key. The
 * blanket 401 below was rejecting all four before their own authentication ever
 * ran — which meant, concretely, that no subscription event could ever have
 * been processed in production.
 *
 * Each of these is authenticated where it is handled, and more strictly than a
 * cookie would be: a signature over the raw body, a constant-time secret
 * comparison, a hashed key resolved to a real context. Listing them here says
 * "not by session", not "not at all".
 */
const SELF_AUTHENTICATING_PREFIXES = [
  '/api/webhooks/',
  '/api/cron/',
  '/api/health',
  '/api/v1/',
  // Browser error reports. Deliberately reachable while signed out, because
  // the errors most worth hearing about happen on the sign-in page. The
  // endpoint bounds itself on body size, rate and shape instead.
  '/api/telemetry/',
] as const

/*
 * Read directly rather than through `@/kernel/config/env`, which is the rule
 * everywhere else. This file runs on the edge runtime for every request, and
 * the config module validates the whole environment with Zod at module load —
 * a cost, and a failure mode, that has no business sitting in front of the
 * sign-in redirect. `NODE_ENV` is also the one variable Next inlines at build
 * time, so there is nothing here to get out of sync.
 */
// eslint-disable-next-line no-restricted-properties
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development'

/**
 * The Content Security Policy.
 *
 * Nonce-based, and therefore worth having. The alternative — a policy with
 * `script-src 'unsafe-inline'` — looks like protection in a security scan while
 * permitting exactly the injection it claims to stop, which is why this header
 * was left out until the nonce existed to make it real.
 *
 * Decisions worth stating:
 *
 * - **`'strict-dynamic'`** lets the nonced Next bootstrap load the chunks it
 *   needs without every chunk URL having to be listed. Host allowlists are
 *   bypassable and go stale; trust propagation from a nonce does not.
 * - **`style-src 'unsafe-inline'`** is a deliberate concession. React writes
 *   `style` attributes and Next inlines the critical CSS, and no nonce reaches
 *   either. An inline style cannot execute script, so the residual risk is
 *   defacement rather than takeover — a much smaller thing than the equivalent
 *   concession for scripts, which is not made.
 * - **`'unsafe-eval'` in development only**, because the dev bundler needs it.
 *   A production build never sees it.
 * - **`frame-ancestors 'none'`** duplicates `X-Frame-Options` on purpose: the
 *   older header is what a browser without CSP support obeys.
 */
function contentSecurityPolicy(nonce: string): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    IS_DEVELOPMENT ? "'unsafe-eval'" : '',
  ]
    .filter(Boolean)
    .join(' ')

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')
}

/** 128 bits of randomness, base64. A guessable nonce is not a nonce. */
function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Attach the policy to both the request and the response.
 *
 * The request copy is how the nonce reaches the render: Next reads it to mark
 * its own bootstrap scripts, and the root layout reads `x-nonce` to pass it to
 * the one third-party inline script in the app.
 */
function withSecurityHeaders(request: NextRequest): NextResponse {
  const nonce = generateNonce()
  const policy = contentSecurityPolicy(nonce)

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', policy)
  return response
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.has(pathname)) return withSecurityHeaders(request)

  if (SELF_AUTHENTICATING_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next()
  }

  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => request.cookies.get(name)?.value)
  if (hasSessionCookie) return withSecurityHeaders(request)

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
