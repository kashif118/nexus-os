import { getSystemDb } from '@/lib/db'

import { isPermission, type Permission } from './catalogue'
import { createPermissionSet, type PermissionSet } from './can'

/**
 * Resolve a membership roles into a permission set.
 *
 * Reads through the system client on purpose: `Role` has a NULLABLE
 * `organizationId` (system templates are shared, custom roles are org-scoped),
 * so it cannot be auto-scoped by the tenant extension. The query is therefore
 * constrained explicitly by `membershipId`, which is itself org-scoped — a
 * membership id belongs to exactly one organization, so this cannot cross
 * tenants.
 */
export interface ResolvedRoles {
  permissions: PermissionSet
  /** Role id is carried so record-level grants can name a role as a subject. */
  roles: Array<{ id: string; key: string; name: string; priority: number }>
}

export async function loadPermissions(input: {
  membershipId: string
  organizationId: string
  isOwner: boolean
}): Promise<ResolvedRoles> {
  const assignments = await getSystemDb().membershipRole.findMany({
    where: { membershipId: input.membershipId, organizationId: input.organizationId },
    select: {
      role: {
        select: {
          id: true,
          key: true,
          name: true,
          priority: true,
          organizationId: true,
          permissions: {
            select: { effect: true, permission: { select: { key: true } } },
          },
        },
      },
    },
  })

  const allowed = new Set<Permission>()
  const denied = new Set<Permission>()
  const roles: ResolvedRoles['roles'] = []

  for (const { role } of assignments) {
    // A custom role must belong to this organization; a system template has no
    // organization. Anything else is a data error and is ignored rather than
    // trusted.
    if (role.organizationId !== null && role.organizationId !== input.organizationId) continue

    roles.push({ id: role.id, key: role.key, name: role.name, priority: role.priority })

    for (const entry of role.permissions) {
      const key = entry.permission.key
      // A key removed from the catalogue but still in the database is ignored:
      // the catalogue is the source of truth.
      if (!isPermission(key)) continue

      if (entry.effect === 'DENY') denied.add(key)
      else allowed.add(key)
    }
  }

  roles.sort((a, b) => b.priority - a.priority)

  return {
    permissions: createPermissionSet({ allowed, denied, isOwner: input.isOwner }),
    roles,
  }
}
