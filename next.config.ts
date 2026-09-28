import type { NextConfig } from 'next'

/**
 * Security headers applied to every response.
 *
 * NOTE: the strict, nonce-based CSP described in `docs/OPERATIONS.md` §N.1 is
 * introduced in Phase 02 together with the middleware that generates the nonce.
 * Shipping a nonce-less CSP now would force `unsafe-inline`, which is worse than
 * no CSP at all because it looks like protection while providing none.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  typescript: {
    // Never ignore type errors during a build.
    ignoreBuildErrors: false,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
