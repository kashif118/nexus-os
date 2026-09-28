'use client'

import { Building2, LayoutDashboard, Settings, ShieldCheck, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

/**
 * Primary navigation.
 *
 * Only routes that actually exist are listed. Modules are added to this array by
 * the phase that builds them, so the sidebar never advertises a dead link.
 */
const NAV = [
  { href: '', label: 'Command Center', Icon: LayoutDashboard },
  { href: '/settings/members', label: 'Members', Icon: Users },
  { href: '/settings/roles', label: 'Roles', Icon: ShieldCheck },
  { href: '/settings', label: 'Settings', Icon: Settings },
] as const

export function SidebarNav({ orgSlug }: { orgSlug: string }) {
  const pathname = usePathname()
  const base = `/${orgSlug}`

  return (
    <nav className="flex-1 space-y-0.5 p-2" aria-label="Main">
      {NAV.map(({ href, label, Icon }) => {
        const target = `${base}${href}`
        const active = href === '' ? pathname === base : pathname === target
        return (
          <Link
            key={label}
            href={target}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {label}
          </Link>
        )
      })}

      <p className="text-muted-foreground/70 flex items-center gap-2 px-2.5 pt-6 text-xs">
        <Building2 className="size-3.5" aria-hidden="true" />
        More modules arrive in later phases
      </p>
    </nav>
  )
}
