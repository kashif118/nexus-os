import Link from 'next/link'
import type { ReactNode } from 'react'

import { requireGuest } from '@/kernel/auth/guards'

/**
 * Shell for the signed-out authentication screens.
 *
 * `requireGuest()` runs on the server, so an already-authenticated visitor is
 * redirected before any of this renders.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  await requireGuest()

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 py-12">
      <Link href="/" className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg font-mono text-sm font-bold"
        >
          N
        </span>
        <span className="font-semibold tracking-tight">NEXUS OS</span>
      </Link>
      <main className="w-full max-w-sm">{children}</main>
    </div>
  )
}
