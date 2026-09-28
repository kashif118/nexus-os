'use client'

import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

export interface OrgSummary {
  id: string
  slug: string
  name: string
  logoUrl: string | null
}

/**
 * Switch between the organizations the user belongs to.
 *
 * Switching is a NAVIGATION, not a state change: the organization lives in the
 * URL (docs/PLATFORM.md §H.2), so moving tenants re-renders the whole tree and
 * partitions caches naturally. There is no client-held "current org" to go
 * stale.
 *
 * Built as a plain popover rather than a Radix dropdown; the full component is
 * introduced with the design system in Phase 05.
 */
export function OrgSwitcher({
  current,
  organizations,
}: {
  current: { slug: string; name: string; logoUrl: string | null }
  organizations: OrgSummary[]
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
      >
        <span
          aria-hidden="true"
          className="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-md font-mono text-xs font-bold"
        >
          {current.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{current.name}</span>
        <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          className="bg-popover absolute top-full left-0 z-50 mt-1 w-64 overflow-hidden rounded-md border shadow-[var(--shadow-lg)]"
        >
          <ul className="max-h-72 overflow-y-auto p-1">
            {organizations.map((organization) => (
              <li key={organization.id}>
                <Link
                  href={`/${organization.slug}`}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                    organization.slug === current.slug
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/60',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  {organization.slug === current.slug ? (
                    <Check className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>

          <div className="border-t p-1">
            <Link
              href="/organizations/new"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="hover:bg-accent/60 flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              New organization
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  )
}
