'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

/** Section navigation. Tabs are filtered server-side by permission. */
export function CrmTabs({ tabs }: { tabs: Array<{ href: string; label: string }> }) {
  const pathname = usePathname()

  return (
    <nav
      className="border-border flex items-center gap-1 overflow-x-auto border-b"
      aria-label="CRM"
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              active
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
