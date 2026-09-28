'use client'

import { Command } from 'cmdk'
import { Building2, LayoutDashboard, Search, Settings, ShieldCheck, Users } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ComponentType } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { OrgSummary } from '@/components/layout/org-switcher'

/**
 * Command palette (⌘K / Ctrl+K).
 *
 * Navigation only, deliberately. Global entity search needs a server round-trip
 * and a permission-filtered index, which arrives with the search module — wiring
 * a fake local filter now would teach users to expect something that is not
 * there.
 *
 * Every destination listed is a route that exists and that the current user can
 * reach; the caller passes the commands, so the palette never advertises a page
 * the actor would get 404 on.
 */

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  href: string
  icon: 'dashboard' | 'members' | 'roles' | 'settings' | 'organization'
}

const ICONS: Record<PaletteCommand['icon'], ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  members: Users,
  roles: ShieldCheck,
  settings: Settings,
  organization: Building2,
}

export function CommandPalette({
  commands,
  organizations,
  currentSlug,
}: {
  commands: PaletteCommand[]
  organizations: OrgSummary[]
  currentSlug: string
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  const otherOrganizations = organizations.filter((entry) => entry.slug !== currentSlug)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:bg-accent hover:text-foreground border-input inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs transition-colors"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="bg-muted hidden rounded px-1 py-0.5 font-mono text-[10px] sm:inline">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl gap-0 overflow-hidden p-0" showClose={false}>
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">
            Jump to a page or switch organization.
          </DialogDescription>

          <Command loop className="w-full">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <Command.Input
                placeholder="Jump to…"
                className="placeholder:text-muted-foreground h-11 w-full bg-transparent text-sm outline-none"
              />
            </div>

            <Command.List className="max-h-80 overflow-y-auto p-1">
              <Command.Empty className="text-muted-foreground py-8 text-center text-sm">
                No matches.
              </Command.Empty>

              <Command.Group
                heading="Go to"
                className="text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold"
              >
                {commands.map((command) => {
                  const Icon = ICONS[command.icon]
                  return (
                    <Command.Item
                      key={command.id}
                      value={`${command.label} ${command.hint ?? ''}`}
                      onSelect={() => go(command.href)}
                      className="text-foreground data-[selected=true]:bg-accent flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm"
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span>{command.label}</span>
                      {command.hint ? (
                        <span className="text-muted-foreground ml-auto text-xs">
                          {command.hint}
                        </span>
                      ) : null}
                    </Command.Item>
                  )
                })}
              </Command.Group>

              {otherOrganizations.length > 0 ? (
                <Command.Group
                  heading="Switch organization"
                  className="text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold"
                >
                  {otherOrganizations.map((organization) => (
                    <Command.Item
                      key={organization.id}
                      value={`organization ${organization.name}`}
                      onSelect={() => go(`/${organization.slug}`)}
                      className="text-foreground data-[selected=true]:bg-accent flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm"
                    >
                      <Building2 className="size-4 shrink-0" aria-hidden="true" />
                      {organization.name}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
