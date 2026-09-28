import type { ReactNode } from 'react'

import { requireUserPage } from '@/kernel/auth/guards'

/**
 * Guard for every authenticated screen.
 *
 * The check is here, on the server, before any child renders. The middleware
 * only looks for the presence of a cookie so it can redirect cheaply at the
 * edge; it is a convenience, never the control (docs/PLATFORM.md §G.4).
 *
 * When organizations arrive this becomes `(app)/[orgSlug]/layout.tsx` calling
 * `requireCtx()`, which additionally resolves membership, roles and permissions.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireUserPage()
  return <>{children}</>
}
