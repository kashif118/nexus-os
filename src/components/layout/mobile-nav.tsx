'use client'

import { Menu } from 'lucide-react'
import { useState } from 'react'

import { OrgSwitcher, type OrgSummary } from '@/components/layout/org-switcher'
import { SidebarNav, type NavItem } from '@/components/layout/sidebar-nav'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/dialog'

/**
 * Navigation on small screens.
 *
 * Reuses the same `SidebarNav` rather than duplicating the menu, so a route
 * added in a later phase appears in both places automatically.
 */
export function MobileNav({
  orgSlug,
  items,
  org,
  organizations,
}: {
  orgSlug: string
  items: NavItem[]
  org: { slug: string; name: string; logoUrl: string | null }
  organizations: OrgSummary[]
}) {
  const [open, setOpen] = useState(false)

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger className="hover:bg-accent inline-flex size-8 items-center justify-center rounded-md transition-colors">
        <Menu className="size-4" aria-hidden="true" />
        <span className="sr-only">Open navigation</span>
      </DrawerTrigger>

      <DrawerContent side="left" className="w-72 p-0">
        <DrawerTitle className="sr-only">Navigation</DrawerTitle>
        <div className="border-b p-3">
          <OrgSwitcher current={org} organizations={organizations} />
        </div>
        <div onClick={() => setOpen(false)} className="flex-1 overflow-y-auto">
          <SidebarNav orgSlug={orgSlug} items={items} />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
