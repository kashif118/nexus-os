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
import { parseListParams } from '@/kernel/validation/list-params'
import { getDb, getSystemDb } from '@/lib/db'

import { PROJECT_SORT_FIELDS } from '../schema'
import * as service from '../service'

/**
 * Projects against a real database.
 *
 * The focus is visibility: a project can be open to the organization, limited to
 * its members, or private, and the rules must hold in the QUERY rather than in
 * the UI. Every assertion about what someone cannot see is the real test.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG_A = `proj-a-${suffix}`
const SLUG_B = `proj-b-${suffix}`
const meta = { ip: null, userAgent: 'vitest-projects' }

const state = {
  orgA: '',
  orgB: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

async function makeCtx(key: string, orgId: string, orgSlug: string, isOwner = false): Promise<Ctx> {
  const membershipId = state.memberships[key]!
  const { permissions, roles } = await loadPermissions({
    membershipId,
    organizationId: orgId,
    isOwner,
  })

  return Object.freeze({
    userId: state.users[key]!,
    sessionId: `s-${key}`,
    orgId,
    orgSlug,
    membershipId,
    isOwner,
    user: { id: state.users[key]!, name: key, email: `${key}@example.test`, emailVerifiedAt: null },
    org: {
      id: orgId,
      slug: orgSlug,
      name: 'Proj Org',
      logoUrl: null,
      timezone: 'UTC',
      currency: 'USD',
    },
    roles,
    permissions,
    can: (p: Permission) => can(permissions, p),
    canAny: (p: readonly Permission[]) => canAny(permissions, p),
    require: (p: Permission) => requirePermission(permissions, p),
    requireAny: (p: readonly Permission[]) => requireAny(permissions, p),
    scope: (a: Permission, b: Permission) => resolveScope(permissions, a, b),
    granted: (c: readonly Permission[]) => grantedFrom(permissions, c),
    db: getDb(orgId),
  })
}

async function seedMember(orgId: string, key: string, roleKey: string) {
  const db = getSystemDb()
  const user = await db.user.create({
    data: { email: `${key}-${suffix}@example.test`, name: key },
    select: { id: true },
  })
  const membership = await db.membership.create({
    data: { organizationId: orgId, userId: user.id, status: 'ACTIVE' },
    select: { id: true },
  })
  const role = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: roleKey },
    select: { id: true },
  })
  await db.membershipRole.create({
    data: { organizationId: orgId, membershipId: membership.id, roleId: role.id },
  })
  state.users[key] = user.id
  state.memberships[key] = membership.id
}

const params = parseListParams({}, { sortableFields: PROJECT_SORT_FIELDS, defaultSort: 'name' })

const baseProject = {
  status: 'ACTIVE',
  priority: 'MEDIUM',
  visibility: 'ORGANIZATION',
}

describe.skipIf(!hasDatabase)('Projects', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    for (const [slug, key] of [
      [SLUG_A, 'ownerA'],
      [SLUG_B, 'ownerB'],
    ] as const) {
      const user = await db.user.create({
        data: { email: `${key}-${suffix}@example.test`, name: key },
        select: { id: true },
      })
      const org = await db.organization.create({
        data: { name: slug, slug, createdById: user.id, currency: 'USD' },
        select: { id: true },
      })
      const membership = await db.membership.create({
        data: { organizationId: org.id, userId: user.id, status: 'ACTIVE' },
        select: { id: true },
      })
      state.users[key] = user.id
      state.memberships[key] = membership.id
      if (key === 'ownerA') state.orgA = org.id
      else state.orgB = org.id
    }

    await seedMember(state.orgA, 'manager', 'manager')
    await seedMember(state.orgA, 'employee', 'employee')
    await seedMember(state.orgA, 'outsider', 'employee')
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('creation', () => {
    it('lets a Manager create a project', async () => {
      const ctx = await makeCtx('manager', state.orgA, SLUG_A)
      const project = await service.createProject(
        ctx,
        { ...baseProject, key: 'ALPHA', name: 'Alpha' },
        meta,
      )
      expect(project.id).toBeTruthy()
    })

    it('refuses an Employee', async () => {
      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(
        service.createProject(ctx, { ...baseProject, key: 'NOPE', name: 'Nope' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('rejects a duplicate key within the organization', async () => {
      const ctx = await makeCtx('manager', state.orgA, SLUG_A)
      await expect(
        service.createProject(ctx, { ...baseProject, key: 'ALPHA', name: 'Clash' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')
    })

    it('allows the same key in a different organization', async () => {
      const ctx = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const project = await service.createProject(
        ctx,
        { ...baseProject, key: 'ALPHA', name: 'Alpha in B' },
        meta,
      )
      expect(project.id).toBeTruthy()
    })

    it('rejects a deadline before the start date', async () => {
      const ctx = await makeCtx('manager', state.orgA, SLUG_A)
      await expect(
        service.createProject(
          ctx,
          {
            ...baseProject,
            key: 'BADDATE',
            name: 'Bad dates',
            startDate: new Date('2026-06-01'),
            dueDate: new Date('2026-05-01'),
          },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })

    it('makes the manager a member automatically', async () => {
      const ctx = await makeCtx('manager', state.orgA, SLUG_A)
      const created = await service.createProject(
        ctx,
        {
          ...baseProject,
          key: 'AUTOMEM',
          name: 'Auto member',
          managerMembershipId: state.memberships.manager,
        },
        meta,
      )

      const project = await service.getProject(ctx, created.id)
      expect(project.members.some((m) => m.membershipId === state.memberships.manager)).toBe(true)
    })

    it('refuses a manager from another organization', async () => {
      const ctx = await makeCtx('manager', state.orgA, SLUG_A)
      await expect(
        service.createProject(
          ctx,
          {
            ...baseProject,
            key: 'XORG',
            name: 'Cross org manager',
            managerMembershipId: state.memberships.ownerB,
          },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })
  })

  describe('visibility', () => {
    it('shows an organization-wide project to any member', async () => {
      const manager = await makeCtx('manager', state.orgA, SLUG_A)
      const created = await service.createProject(
        ctx0(manager),
        { ...baseProject, key: 'OPEN1', name: 'Open project', visibility: 'ORGANIZATION' },
        meta,
      )

      const employee = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(service.getProject(employee, created.id)).resolves.toBeTruthy()
    })

    it('hides a private project from a non-member', async () => {
      const manager = await makeCtx('manager', state.orgA, SLUG_A)
      const created = await service.createProject(
        manager,
        { ...baseProject, key: 'PRIV1', name: 'Private project', visibility: 'PRIVATE' },
        meta,
      )

      // The employee holds only project.read.member, so the query filter
      // excludes a project they do not belong to.
      const employee = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(service.getProject(employee, created.id)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('shows a private project once the person is added to it', async () => {
      const manager = await makeCtx('manager', state.orgA, SLUG_A)
      const created = await service.createProject(
        manager,
        { ...baseProject, key: 'PRIV2', name: 'Private with member', visibility: 'PRIVATE' },
        meta,
      )

      await service.addMember(
        manager,
        {
          projectId: created.id,
          membershipId: state.memberships.employee!,
          role: 'CONTRIBUTOR',
          allocationPercent: 50,
        },
        meta,
      )

      const employee = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(service.getProject(employee, created.id)).resolves.toBeTruthy()
    })

    it('excludes private projects from a restricted list', async () => {
      const manager = await makeCtx('manager', state.orgA, SLUG_A)
      await service.createProject(
        manager,
        { ...baseProject, key: 'PRIV3', name: 'Hidden from list', visibility: 'PRIVATE' },
        meta,
      )

      const outsider = await makeCtx('outsider', state.orgA, SLUG_A)
      const page = await service.listProjects(outsider, params)
      expect(page.items.some((item) => item.key === 'PRIV3')).toBe(false)
    })

    it('shows every project to someone with project.read.any', async () => {
      const manager = await makeCtx('manager', state.orgA, SLUG_A)
      const page = await service.listProjects(manager, params)
      expect(page.items.some((item) => item.key === 'PRIV3')).toBe(true)
    })
  })

  describe('tenant isolation', () => {
    it('cannot read a project from another organization', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const created = await service.createProject(
        ctxB,
        { ...baseProject, key: 'SECRET', name: 'Org B secret' },
        meta,
      )

      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(service.getProject(ctxA, created.id)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('cannot add a member from another organization', async () => {
      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const created = await service.createProject(
        ctxA,
        { ...baseProject, key: 'XMEMBER', name: 'Cross member' },
        meta,
      )

      await expect(
        service.addMember(
          ctxA,
          {
            projectId: created.id,
            membershipId: state.memberships.ownerB!,
            role: 'CONTRIBUTOR',
            allocationPercent: 0,
          },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })
  })

  describe('health', () => {
    it('recomputes health when a milestone is missed', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const created = await service.createProject(
        ctx,
        { ...baseProject, key: 'HEALTH1', name: 'Health project' },
        meta,
      )

      const before = await service.getProject(ctx, created.id)
      expect(before.healthStatus).toBe('HEALTHY')

      await service.createMilestone(
        ctx,
        { projectId: created.id, name: 'Overdue milestone', dueDate: new Date('2020-01-01') },
        meta,
      )

      const after = await service.getProject(ctx, created.id)
      expect(after.healthScore).toBeLessThan(before.healthScore)
    })

    it('explains why the score moved', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const created = await service.createProject(
        ctx,
        { ...baseProject, key: 'HEALTH2', name: 'Explained', dueDate: new Date('2020-01-01') },
        meta,
      )

      const project = await service.getProject(ctx, created.id)
      expect(project.assessment.signals.length).toBeGreaterThan(0)
      expect(project.assessment.signals[0]?.label).toBeTruthy()
    })
  })

  describe('budget permission', () => {
    it('ignores a budget change from someone without budget.manage', async () => {
      const owner = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const created = await service.createProject(
        owner,
        { ...baseProject, key: 'BUDGET1', name: 'Budgeted', budgetMinor: 100_000n },
        meta,
      )

      // A Manager can edit the project but does not hold project.budget.manage.
      const manager = await makeCtx('manager', state.orgA, SLUG_A)
      await service.updateProject(
        manager,
        created.id,
        { ...baseProject, key: 'BUDGET1', name: 'Budgeted renamed', budgetMinor: 999_999n },
        meta,
      )

      const project = await service.getProject(owner, created.id)
      expect(project.name).toBe('Budgeted renamed')
      expect(project.budgetMinor).toBe(100_000n)
    })
  })
})

/** Identity helper so the visibility test reads clearly. */
const ctx0 = (ctx: Ctx) => ctx
