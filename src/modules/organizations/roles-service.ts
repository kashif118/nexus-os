import { writeAuditLog } from '@/kernel/audit/write'
import { isPermission, type Permission } from '@/kernel/authz/catalogue'
import { conflict, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'

import * as repository from './repository'
import * as rolesRepository from './roles-repository'

/**
 * Role assignment rules.
 *
 * Two invariants hold here, and both are enforced server-side regardless of what
 * the UI offers:
 *
 * 1. **An organization always keeps an owner.** Removing the last Owner role, or
 *    the acting owner removing their own, is refused — otherwise the tenant
 *    becomes unadministrable.
 * 2. **Nobody grants what they do not hold.** Privilege escalation through the
 *    role editor is the classic RBAC hole: an Admin must not be able to hand out
 *    a permission they lack and then assume that role.
 */

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

export async function listAssignableRoles(ctx: Ctx) {
  ctx.require('organization.roles.manage')
  return rolesRepository.listAssignableRoles(ctx)
}

export async function listMembershipRoles(ctx: Ctx) {
  // Reading who holds which role needs only membership visibility — the members
  // screen shows it to anyone who can see the member list.
  return rolesRepository.listMembershipRoles(ctx)
}

export async function getRolePermissions(ctx: Ctx, roleId: string) {
  ctx.require('organization.roles.manage')

  const role = await rolesRepository.findAssignableRole(ctx, roleId)
  if (!role) throw notFound('That role is not available in this organization.')

  const grants = await rolesRepository.listRolePermissions(roleId)
  return {
    role,
    permissions: grants
      .map((grant) => ({
        key: grant.permission.key,
        module: grant.permission.module,
        description: grant.permission.description,
        effect: grant.effect,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  }
}

export async function assignRole(
  ctx: Ctx,
  input: { membershipId: string; roleId: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.roles.manage')

  const membership = await repository.findMembership(ctx, input.membershipId)
  if (!membership) throw notFound('That member is no longer in this organization.')

  const role = await rolesRepository.findAssignableRole(ctx, input.roleId)
  if (!role) throw notFound('That role is not available in this organization.')

  await assertNoEscalation(ctx, input.roleId)

  await rolesRepository.assignRole(ctx, input.membershipId, input.roleId)

  await writeAuditLog({
    action: 'organization.role_assigned',
    entityType: 'Membership',
    entityId: input.membershipId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { roleKey: role.key },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function unassignRole(
  ctx: Ctx,
  input: { membershipId: string; roleId: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.roles.manage')

  const role = await rolesRepository.findAssignableRole(ctx, input.roleId)
  if (!role) throw notFound('That role is not available in this organization.')

  // Never leave the organization without an owner.
  if (role.key === 'owner') {
    const owners = await rolesRepository.countHoldersOfRole(ctx, 'owner')
    if (owners <= 1) {
      throw validationError(
        'This is the last Owner. Give someone else the Owner role before removing it.',
      )
    }
  }

  const removed = await rolesRepository.unassignRole(ctx, input.membershipId, input.roleId)
  if (removed === 0) throw notFound('That member does not hold that role.')

  await writeAuditLog({
    action: 'organization.role_unassigned',
    entityType: 'Membership',
    entityId: input.membershipId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { roleKey: role.key },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Refuse to grant a role carrying permissions the actor does not hold.
 *
 * Without this, an Admin could create or assign a role containing
 * `organization.billing.manage`, assign it to themselves, and escalate. The
 * owner short-circuit means an Owner passes this trivially, which is correct.
 */
async function assertNoEscalation(ctx: Ctx, roleId: string): Promise<void> {
  if (ctx.isOwner) return

  const grants = await rolesRepository.listRolePermissions(roleId)

  const escalating = grants
    .filter((grant) => grant.effect === 'ALLOW')
    .map((grant) => grant.permission.key)
    .filter((key): key is Permission => isPermission(key))
    .filter((key) => !ctx.can(key))

  if (escalating.length > 0) {
    throw conflict('That role includes permissions you do not have, so you cannot grant it.')
  }
}
