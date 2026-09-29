import type { MetadataRoute } from 'next'

/**
 * Keep the product out of search results.
 *
 * Every page behind `/` is one organization's private data and answers 404 to
 * anyone who is not a member, so nothing here is indexable in practice. This
 * file makes that explicit rather than relying on the guard: a crawler should
 * not be spending requests discovering that, and an indexed sign-in page with a
 * customer's organization name in the URL is a disclosure in itself.
 *
 * It complements the `robots: { index: false }` metadata on the root layout,
 * which is the per-page instruction; this is the site-wide one.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  }
}
