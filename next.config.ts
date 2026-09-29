import type { NextConfig } from 'next'

/**
 * Security headers applied to every response.
 *
 * The Content-Security-Policy is NOT here: it carries a per-request nonce, so
 * it is set in `src/proxy.ts` where a value can be generated per response.
 * These are the static ones.
 *
 * HSTS is production-only and deliberately so. Sending it in development would
 * pin `localhost` to HTTPS in the developer's browser for a year, which is
 * remarkably annoying to undo.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  ...(process.env.NODE_ENV === 'production'
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]
    : []),
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
