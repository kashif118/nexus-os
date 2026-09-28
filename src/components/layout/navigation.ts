import type { PaletteCommand } from '@/components/layout/command-palette'
import type { NavItem } from '@/components/layout/sidebar-nav'
import type { Permission } from '@/kernel/authz/catalogue'

/**
 * The navigation model.
 *
 * Each entry declares the permission that makes it reachable, and the server
 * filters the list before it ever reaches the client. That keeps two things
 * true: the sidebar never links to a page the actor would get 404 on, and the
 * client is not handed a map of the pages it cannot see.
 *
 * Modules are added here by the phase that builds them.
 */
export interface NavDefinition extends NavItem {
  /** Any one of these permissions makes the entry visible. */
  requires?: Permission[]
}

export const NAVIGATION: NavDefinition[] = [
  { href: '', label: 'Command Center', icon: 'dashboard' },
  {
    href: '/settings/members',
    label: 'Members',
    icon: 'members',
    section: 'Administration',
  },
  {
    href: '/settings/roles',
    label: 'Roles',
    icon: 'roles',
    section: 'Administration',
    requires: ['organization.roles.manage'],
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: 'settings',
    section: 'Administration',
  },
]

export function navigationFor(can: (permission: Permission) => boolean): NavItem[] {
  return NAVIGATION.filter(
    (entry) => !entry.requires || entry.requires.some((permission) => can(permission)),
  ).map(({ requires: _requires, ...item }) => item)
}

const PALETTE_ICON: Record<string, PaletteCommand['icon']> = {
  dashboard: 'dashboard',
  members: 'members',
  roles: 'roles',
  settings: 'settings',
}

export function commandsFor(
  orgSlug: string,
  can: (permission: Permission) => boolean,
): PaletteCommand[] {
  return navigationFor(can).map((item) => ({
    id: item.href || 'home',
    label: item.label,
    href: `/${orgSlug}${item.href}`,
    icon: PALETTE_ICON[item.icon] ?? 'organization',
    ...(item.section ? { hint: item.section } : {}),
  }))
}
