import { cookies } from 'next/headers'

import { isProduction } from '@/kernel/config/env'

/**
 * Remembers which organization the user was last in, purely to choose a landing
 * page after sign-in.
 *
 * This cookie is NEVER the source of tenancy: the organization always comes from
 * the URL path (docs/PLATFORM.md §H.2). A stale value can at worst send someone
 * to a slug they no longer belong to, which resolves to 404.
 */
const LAST_ORG_COOKIE = isProduction ? '__Host-nexus_last_org' : 'nexus_last_org'

export async function rememberLastOrg(slug: string): Promise<void> {
  const store = await cookies()
  store.set(LAST_ORG_COOKIE, slug, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
}

export async function readLastOrg(): Promise<string | null> {
  const store = await cookies()
  return store.get(LAST_ORG_COOKIE)?.value ?? null
}
