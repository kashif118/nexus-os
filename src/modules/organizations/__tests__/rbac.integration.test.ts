import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  can,
  canAny,
  grantedFrom,
  require as requirePermission,
  requireAny,
  resolveScope,
} from '@/kernel/authz/can'
import type { Permission } from '@/kernel/authz/catalogue'
import { loadPermissions } from '@/kernel/authz/load'
import { isAppError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb } from '@/lib/db'

import * as rolesService from '../roles-service'
import * as service from '../service'

/**
 * RBAC against a real database.
 *
 * The matrix in `kernel/authz/__tests__` proves the decision function is
 * correct. This proves the whole path: roles stored in Postgres, resolved by the
 * real loader, enforced by real service functions.
 *
 * Every assertion here is an UNAUTHORIZED access attempt that must fail. A test
 * that only proves the happy path proves nothing about security.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `rbac-${suffix}`

let orgId = ''
const userIds: Record<string, string> = {}
const membershipIds: Record<string, string> = {}
const roleIds: Record<string, string> = {}

const meta = { ip: '198.51.100.9', userAgent: 'vitest-rbac' }

/**
 * Build a Ctx the same way the real loader does.
 *
 * Permissions come from `loadPermissions` reading actual database rows, so this
 * cannot drift from production behaviour — only the session lookup (which needs
 * cookies) is replaced.
 */
async function makeCtx(roleKey: string, isOwner = false): Promise<Ctx> {
  const membershipId = membershipIds[roleKey]!
  const { permissions, roles } = await loadPermissions({
    membershipId,
    organizationId: orgId,
    isOwner,
  })

  return Object.freeze({
    userId: userIds[roleKey]!,
    sessionId: `session-${roleKey}`,
    orgId,
    orgSlug: SLUG,
    membershipId,
    isOwner,
    user: {
      id: userIds[roleKey]!,
      name: roleKey,
      email: `${roleKey}-${suffix}@example.test`,
      emailVerifiedAt: null,
    },
    org: {
      id: orgId,
      slug: SLUG,
      name: 'RBAC Test Org',
      logoUrl: null,
      timezone: 'UTC',
      currency: 'USD',
    },
    roles,
    permissions,
    can: (permission: Permission) => can(permissions, permission),
    canAny: (candidates: readonly Permission[]) => canAny(permissions, candidates),
    require: (permission: Permission) => requirePermission(permissions, permission),
    requireAny: (candidates: readonly Permission[]) => requireAny(permissions, candidates),
    scope: (a: Permission, b: Permission) => resolveScope(permissions, a, b),
    granted: (candidates: readonly Permission[]) => grantedFrom(permissions, candidates),
    db: getDb(orgId),
  })
}

const ROLE_KEYS = [
  'owner',
  'admin',
  'manager',
  'employee',
  'finance_manager',
  'hr_manager',
  'client',
]

describe.skipIf(!hasDatabase)('RBAC end to end', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const owner = await db.user.create({
      data: { email: `owner-${suffix}@example.test`, name: 'owner' },
      select: { id: true },
    })
    userIds.owner = owner.id

    const organization = await db.organization.create({
      data: { name: 'RBAC Test Org', slug: SLUG, createdById: owner.id },
      select: { id: true },
    })
    orgId = organization.id

    for (const key of ROLE_KEYS) {
      const user =
        key === 'owner'
          ? owner
          : await db.user.create({
              data: { email: `${key}-${suffix}@example.test`, name: key },
              select: { id: true },
            })
      userIds[key] = user.id

      const membership = await db.membership.create({
        data: { organizationId: orgId, userId: user.id, status: 'ACTIVE' },
        select: { id: true },
      })
      membershipIds[key] = membership.id

      const role = await db.role.findFirstOrThrow({
        where: { organizationId: null, key },
        select: { id: true },
      })
      roleIds[key] = role.id

      await db.membershipRole.create({
        data: { organizationId: orgId, membershipId: membership.id, roleId: role.id },
      })
    }
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: SLUG } })
    await db.user.deleteMany({ where: { id: { in: Object.values(userIds) } } })
    await db.$disconnect()
  })

  describe('permission resolution from the database', () => {
    it('resolves the roles a membership actually holds', async () => {
      const ctx = await makeCtx('manager')
      expect(ctx.roles.map((role) => role.key)).toEqual(['manager'])
    })

    it('grants a Manager what the matrix says', async () => {
      const ctx = await makeCtx('manager')
      expect(ctx.can('project.create')).toBe(true)
      expect(ctx.can('finance.invoice.create')).toBe(false)
    })

    it('applies the owner short-circuit only for the real owner', async () => {
      const owner = await makeCtx('owner', true)
      const employee = await makeCtx('employee')
      expect(owner.can('organization.billing.manage')).toBe(true)
      expect(employee.can('organization.billing.manage')).toBe(false)
    })
  })

  describe('organization settings', () => {
    const update = {
      name: 'Renamed',
      timezone: 'UTC',
      currency: 'USD',
    }

    it('refuses an Employee', async () => {
      const ctx = await makeCtx('employee')
      await expect(service.updateOrganization(ctx, update, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses a Manager', async () => {
      const ctx = await makeCtx('manager')
      await expect(service.updateOrganization(ctx, update, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses a Finance Manager', async () => {
      const ctx = await makeCtx('finance_manager')
      await expect(service.updateOrganization(ctx, update, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses the external Client', async () => {
      const ctx = await makeCtx('client')
      await expect(service.updateOrganization(ctx, update, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('allows an Admin', async () => {
      const ctx = await makeCtx('admin')
      await expect(service.updateOrganization(ctx, update, meta)).resolves.toBeUndefined()
    })
  })

  describe('inviting members', () => {
    it('refuses an Employee', async () => {
      const ctx = await makeCtx('employee')
      await expect(
        service.inviteMember(ctx, { email: `nope-${suffix}@example.test` }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('refuses a Manager', async () => {
      const ctx = await makeCtx('manager')
      await expect(
        service.inviteMember(ctx, { email: `nope2-${suffix}@example.test` }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('allows an HR Manager, who holds the invite permission', async () => {
      const ctx = await makeCtx('hr_manager')
      await expect(
        service.inviteMember(ctx, { email: `hr-invite-${suffix}@example.test` }, meta),
      ).resolves.toBeUndefined()
    })
  })

  describe('removing members', () => {
    it('refuses an Employee', async () => {
      const ctx = await makeCtx('employee')
      await expect(service.removeMember(ctx, membershipIds.manager!, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses an HR Manager, who can invite but not remove', async () => {
      const ctx = await makeCtx('hr_manager')
      await expect(service.removeMember(ctx, membershipIds.manager!, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })
  })

  describe('role management', () => {
    it('refuses a Manager', async () => {
      const ctx = await makeCtx('manager')
      await expect(rolesService.listAssignableRoles(ctx)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses an Employee assigning themselves a better role', async () => {
      const ctx = await makeCtx('employee')
      await expect(
        rolesService.assignRole(
          ctx,
          { membershipId: membershipIds.employee!, roleId: roleIds.admin! },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('refuses the external Client outright', async () => {
      const ctx = await makeCtx('client')
      await expect(
        rolesService.assignRole(
          ctx,
          { membershipId: membershipIds.client!, roleId: roleIds.manager! },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('stops an Admin granting a role that exceeds their own permissions', async () => {
      // The Owner role carries organization.billing.manage, which an Admin does
      // not hold. Granting it would be privilege escalation.
      const ctx = await makeCtx('admin')
      await expect(
        rolesService.assignRole(
          ctx,
          { membershipId: membershipIds.employee!, roleId: roleIds.owner! },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')
    })

    it('lets an Admin grant a role within their own permissions', async () => {
      const ctx = await makeCtx('admin')
      await expect(
        rolesService.assignRole(
          ctx,
          { membershipId: membershipIds.employee!, roleId: roleIds.manager! },
          meta,
        ),
      ).resolves.toBeUndefined()

      const updated = await makeCtx('employee')
      expect(updated.can('project.create')).toBe(true)
    })

    it('refuses to remove the last Owner', async () => {
      const ctx = await makeCtx('owner', true)
      await expect(
        rolesService.unassignRole(
          ctx,
          { membershipId: membershipIds.owner!, roleId: roleIds.owner! },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && /last Owner/i.test(error.message))
    })
  })

  describe('cross-tenant role assignment', () => {
    it('cannot assign a role to a membership in another organization', async () => {
      const db = getSystemDb()
      const otherUser = await db.user.create({
        data: { email: `other-${suffix}@example.test`, name: 'other' },
        select: { id: true },
      })
      const otherOrg = await db.organization.create({
        data: { name: 'Other', slug: `other-${suffix}`, createdById: otherUser.id },
        select: { id: true },
      })
      const otherMembership = await db.membership.create({
        data: { organizationId: otherOrg.id, userId: otherUser.id, status: 'ACTIVE' },
        select: { id: true },
      })

      const ctx = await makeCtx('owner', true)

      // The membership id is real, but belongs to another tenant, so the
      // org-scoped lookup simply does not find it.
      await expect(
        rolesService.assignRole(
          ctx,
          { membershipId: otherMembership.id, roleId: roleIds.admin! },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'NOT_FOUND')

      await db.organization.delete({ where: { id: otherOrg.id } })
      await db.user.delete({ where: { id: otherUser.id } })
    })
  })
})
