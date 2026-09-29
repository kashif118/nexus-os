import type { ReactNode } from 'react'

import { CommandPalette, type PaletteCommand } from '@/components/layout/command-palette'
import { MobileNav } from '@/components/layout/mobile-nav'
import { OrgSwitcher, type OrgSummary } from '@/components/layout/org-switcher'
import { SidebarNav, type NavItem } from '@/components/layout/sidebar-nav'
import { UserMenu } from '@/components/layout/user-menu'

/**
 * The authenticated application frame.
 *
 * Takes plain, serialisable props rather than a `Ctx`: the context object holds
 * a live Prisma client and a permission set, neither of which may cross to the
 * client.
 *
 * Navigation is PASSED IN, already filtered by the caller against the actor
 * permissions, so the sidebar can never advertise a page that would 404. The
 * shell itself makes no authorization decisions.
 */
export function AppShell({
  org,
  user,
  organizations,
  navigation,
  commands,
  notificationBell,
  children,
}: {
  org: { slug: string; name: string; logoUrl: string | null }
  user: { name: string; email: string }
  organizations: OrgSummary[]
  navigation: NavItem[]
  commands: PaletteCommand[]
  /** Rendered in the header. Passed in so the shell needs no data access. */
  notificationBell?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="bg-background flex min-h-dvh">
      <aside className="bg-card hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="border-b p-3">
          <OrgSwitcher current={org} organizations={organizations} />
        </div>
        <SidebarNav orgSlug={org.slug} items={navigation} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur md:px-6">
          <div className="md:hidden">
            <MobileNav
              orgSlug={org.slug}
              items={navigation}
              org={org}
              organizations={organizations}
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <CommandPalette
              commands={commands}
              organizations={organizations}
              currentSlug={org.slug}
            />
            {notificationBell}
            <UserMenu user={user} />
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
      </div>
    </div>
  )
}
