'use client'

import {
  Banknote,
  Bot,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  Settings,
  ShieldCheck,
  Users,
  Users2,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

/**
 * Primary navigation.
 *
 * Items are supplied by the server, already filtered against the actor
 * permissions, so this component renders what it is given and decides nothing.
 * Icons are referenced by name because a React component cannot be serialised
 * across the server/client boundary.
 */

export type NavIcon =
  | 'dashboard'
  | 'crm'
  | 'projects'
  | 'tasks'
  | 'people'
  | 'finance'
  | 'documents'
  | 'workflows'
  | 'ai'
  | 'members'
  | 'roles'
  | 'settings'

export interface NavItem {
  href: string
  label: string
  icon: NavIcon
  /** Rendered under a heading; items with no section come first. */
  section?: string
}

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  crm: Users2,
  projects: FolderKanban,
  tasks: ListChecks,
  people: Users,
  finance: Banknote,
  documents: FileText,
  workflows: Workflow,
  ai: Bot,
  members: Users,
  roles: ShieldCheck,
  settings: Settings,
}

export function SidebarNav({ orgSlug, items }: { orgSlug: string; items: NavItem[] }) {
  const pathname = usePathname()
  const base = `/${orgSlug}`

  const sections = new Map<string, NavItem[]>()
  for (const item of items) {
    const key = item.section ?? ''
    sections.set(key, [...(sections.get(key) ?? []), item])
  }

  return (
    <nav className="flex-1 space-y-4 overflow-y-auto p-2" aria-label="Main">
      {[...sections.entries()].map(([section, sectionItems]) => (
        <div key={section || 'primary'} className="space-y-0.5">
          {section ? (
            <h2 className="text-muted-foreground/70 px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
              {section}
            </h2>
          ) : null}

          {sectionItems.map((item) => {
            const target = `${base}${item.href}`
            // Exact match for the dashboard, prefix match elsewhere, so a detail
            // page keeps its section highlighted.
            const active =
              item.href === ''
                ? pathname === base
                : pathname === target || pathname.startsWith(`${target}/`)
            const Icon = ICONS[item.icon]

            return (
              <Link
                key={item.href}
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
                {item.label}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
