import type { ReactNode } from 'react'

import { OrgSwitcher, type OrgSummary } from '@/components/layout/org-switcher'
import { SidebarNav } from '@/components/layout/sidebar-nav'
import { UserMenu } from '@/components/layout/user-menu'

/**
 * The authenticated application frame.
 *
 * Takes plain, serialisable props rather than a `Ctx`: the context object holds
 * a live Prisma client, which must never be handed to a client component.
 *
 * Phase 05 expands this with the command palette, breadcrumbs and notification
 * surface. The structure — fixed sidebar, sticky header, scrollable content —
 * is fixed here so every module page inherits the same skeleton.
 */
export function AppShell({
  org,
  user,
  organizations,
  children,
}: {
  org: { slug: string; name: string; logoUrl: string | null }
  user: { name: string; email: string }
  organizations: OrgSummary[]
  children: ReactNode
}) {
  return (
    <div className="bg-background flex min-h-dvh">
      <aside className="bg-card hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="border-b p-3">
          <OrgSwitcher current={org} organizations={organizations} />
        </div>
        <SidebarNav orgSlug={org.slug} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b px-4 backdrop-blur md:px-6">
          <div className="md:hidden">
            <OrgSwitcher current={org} organizations={organizations} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <UserMenu user={user} />
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
      </div>
    </div>
  )
}
