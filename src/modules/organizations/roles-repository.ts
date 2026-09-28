import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

/**
 * Role data access.
 *
 * Separated from `repository.ts` because `Role` has a NULLABLE
 * `organizationId` — system templates are shared across every tenant — so it is
 * excluded from the auto-scoped tenant models and must be constrained
 * explicitly. Every query here therefore carries either
 * `organizationId: ctx.orgId` or `organizationId: null` deliberately, and
 * `MembershipRole` (which IS auto-scoped) is written through `ctx.db`.
 */

/** Roles an organization can assign: the shared system templates plus its own. */
export async function listAssignableRoles(ctx: Ctx) {
  return getSystemDb().role.findMany({
    where: { OR: [{ organizationId: null }, { organizationId: ctx.orgId }] },
    orderBy: { priority: 'desc' },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      priority: true,
      isSystem: true,
      organizationId: true,
      _count: { select: { permissions: true } },
    },
  })
}

export async function findRoleByKey(key: string, organizationId: string | null) {
  return getSystemDb().role.findFirst({
    where: { key, organizationId },
    select: { id: true, key: true, name: true, isSystem: true },
  })
}

/**
 * A role may be assigned only if it is a system template or belongs to this
 * organization. Checked here rather than trusted from the form.
 */
export async function findAssignableRole(ctx: Ctx, roleId: string) {
  return getSystemDb().role.findFirst({
    where: { id: roleId, OR: [{ organizationId: null }, { organizationId: ctx.orgId }] },
    select: { id: true, key: true, name: true, priority: true },
  })
}

export async function listRolePermissions(roleId: string) {
  return getSystemDb().rolePermission.findMany({
    where: { roleId },
    select: {
      effect: true,
      permission: { select: { key: true, module: true, description: true } },
    },
  })
}

/** Roles held by each membership in the organization. */
export async function listMembershipRoles(ctx: Ctx) {
  return ctx.db.membershipRole.findMany({
    select: {
      id: true,
      membershipId: true,
      role: { select: { id: true, key: true, name: true, priority: true } },
    },
  })
}

export async function listRolesForMembership(ctx: Ctx, membershipId: string) {
  return ctx.db.membershipRole.findMany({
    where: { membershipId },
    select: { id: true, role: { select: { id: true, key: true, name: true, priority: true } } },
  })
}

export async function assignRole(ctx: Ctx, membershipId: string, roleId: string) {
  return ctx.db.membershipRole.upsert({
    where: { membershipId_roleId: { membershipId, roleId } },
    create: {
      organizationId: ctx.orgId,
      membershipId,
      roleId,
      assignedById: ctx.userId,
    },
    update: {},
    select: { id: true },
  })
}

export async function unassignRole(ctx: Ctx, membershipId: string, roleId: string) {
  const result = await ctx.db.membershipRole.deleteMany({ where: { membershipId, roleId } })
  return result.count
}

export async function countHoldersOfRole(ctx: Ctx, roleKey: string): Promise<number> {
  return ctx.db.membershipRole.count({
    where: { role: { key: roleKey }, membership: { status: 'ACTIVE' } },
  })
}

/**
 * Give a new organization its first member the Owner role.
 *
 * Runs in the same transaction as organization creation so an organization can
 * never exist without someone able to administer it.
 */
export async function assignSystemRoleDirect(input: {
  organizationId: string
  membershipId: string
  roleKey: string
  assignedById: string | null
}): Promise<void> {
  const db = getSystemDb()

  const role = await db.role.findFirst({
    where: { organizationId: null, key: input.roleKey },
    select: { id: true },
  })

  if (!role) {
    throw new Error(
      `System role "${input.roleKey}" is missing. Run "npm run db:seed" to reconcile the role templates.`,
    )
  }

  await db.membershipRole.upsert({
    where: { membershipId_roleId: { membershipId: input.membershipId, roleId: role.id } },
    create: {
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      roleId: role.id,
      assignedById: input.assignedById,
    },
    update: {},
  })
}
