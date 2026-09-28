'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

import { ThemeToggle } from '@/components/theme-toggle'

/**
 * Account menu. Sign-out posts to a Server Action so it works without
 * client-side JavaScript and cannot be triggered cross-origin.
 */
export function UserMenu({
  user,
  signOutAction,
}: {
  user: { name: string; email: string }
  signOutAction?: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="bg-secondary text-secondary-foreground hover:bg-accent grid size-8 place-items-center rounded-full text-xs font-semibold transition-colors"
      >
        <span className="sr-only">Account menu</span>
        {user.name.charAt(0).toUpperCase()}
      </button>

      {open ? (
        <div
          role="menu"
          className="bg-popover absolute top-full right-0 z-50 mt-1 w-60 rounded-md border p-1 shadow-[var(--shadow-lg)]"
        >
          <div className="border-b px-2 py-2">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="text-muted-foreground truncate text-xs">{user.email}</p>
          </div>

          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="hover:bg-accent/60 block rounded-sm px-2 py-1.5 text-sm transition-colors"
          >
            Account and security
          </Link>

          <div className="flex items-center justify-between gap-2 px-2 py-2">
            <span className="text-muted-foreground text-xs">Theme</span>
            <ThemeToggle />
          </div>

          {signOutAction ? (
            <form action={signOutAction} className="border-t pt-1">
              <button
                type="submit"
                className="hover:bg-accent/60 w-full rounded-sm px-2 py-1.5 text-left text-sm transition-colors"
              >
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
