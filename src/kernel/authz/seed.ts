import { getSystemDb } from '@/lib/db'

import { ALL_PERMISSIONS, describePermission, splitPermission } from './catalogue'
import { resolveRolePermissions, SYSTEM_ROLES } from './roles'

/**
 * Seed the permission catalogue and the system role templates.
 *
 * Idempotent, and run on every deploy rather than once: it is a reconciliation,
 * not a migration. Adding a permission to the catalogue and redeploying is all
 * that is needed for it to exist in the database and be attached to the roles
 * that should hold it.
 *
 * Permissions removed from the catalogue are deliberately NOT deleted — a
 * dangling grant is inert (the loader ignores unknown keys), whereas cascading a
 * delete through `RolePermission` would silently strip access from custom roles.
 */
export async function seedAuthorization(): Promise<{
  permissions: number
  roles: number
  grants: number
}> {
  const db = getSystemDb()

  // 1. Permissions.
  await db.$transaction(
    ALL_PERMISSIONS.map((key) => {
      const { module, action } = splitPermission(key)
      const description = describePermission(key)
      return db.permission.upsert({
        where: { key },
        create: { key, module, action, description },
        update: { module, action, description },
      })
    }),
  )

  const permissionRows = await db.permission.findMany({ select: { id: true, key: true } })
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]))

  // 2. System role templates. organizationId is null: shared by every tenant.
  let grants = 0

  for (const definition of SYSTEM_ROLES) {
    const existing = await db.role.findFirst({
      where: { organizationId: null, key: definition.key },
      select: { id: true },
    })

    const role = existing
      ? await db.role.update({
          where: { id: existing.id },
          data: {
            name: definition.name,
            description: definition.description,
            priority: definition.priority,
            isSystem: true,
          },
          select: { id: true },
        })
      : await db.role.create({
          data: {
            organizationId: null,
            key: definition.key,
            name: definition.name,
            description: definition.description,
            priority: definition.priority,
            isSystem: true,
          },
          select: { id: true },
        })

    const { allow, deny } = resolveRolePermissions(definition)

    // DENY overrides ALLOW, so a key in both lists is stored once, as DENY.
    const effects = new Map<string, 'ALLOW' | 'DENY'>()
    for (const key of allow) effects.set(key, 'ALLOW')
    for (const key of deny) effects.set(key, 'DENY')

    await db.$transaction(
      [...effects].flatMap(([key, effect]) => {
        const permissionId = permissionIdByKey.get(key)
        if (!permissionId) return []
        grants += 1
        return db.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId } },
          create: { roleId: role.id, permissionId, effect },
          update: { effect },
        })
      }),
    )

    // Remove grants that are no longer part of the definition, so tightening a
    // system role actually tightens it.
    const keepIds = [...effects.keys()]
      .map((key) => permissionIdByKey.get(key))
      .filter((id): id is string => Boolean(id))

    await db.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: keepIds } },
    })
  }

  return { permissions: ALL_PERMISSIONS.length, roles: SYSTEM_ROLES.length, grants }
}
