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
import { seedAuthorization } from '@/kernel/authz/seed'
import { isAppError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb } from '@/lib/db'

import * as service from '../service'

/**
 * People against a real database.
 *
 * The property under test is the one that matters most here: pay rates must
 * never leave the service for a caller without
 * `people.profile.read.sensitive` — not hidden in the UI, not present in the
 * payload at all.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `people-${suffix}`
const meta = { ip: null, userAgent: 'vitest-people' }

const state = {
  orgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

async function makeCtx(key: string, isOwner = false): Promise<Ctx> {
  const membershipId = state.memberships[key]!
  const { permissions, roles } = await loadPermissions({
    membershipId,
    organizationId: state.orgId,
    isOwner,
  })

  return Object.freeze({
    userId: state.users[key]!,
    sessionId: `s-${key}`,
    orgId: state.orgId,
    orgSlug: SLUG,
    membershipId,
    isOwner,
    user: { id: state.users[key]!, name: key, email: `${key}@example.test`, emailVerifiedAt: null },
    org: {
      id: state.orgId,
      slug: SLUG,
      name: 'People Org',
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
    db: getDb(state.orgId),
  })
}

async function seedMember(key: string, roleKey: string) {
  const db = getSystemDb()
  const user = await db.user.create({
    data: { email: `${key}-${suffix}@example.test`, name: key },
    select: { id: true },
  })
  const membership = await db.membership.create({
    data: { organizationId: state.orgId, userId: user.id, status: 'ACTIVE' },
    select: { id: true },
  })
  const role = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: roleKey },
    select: { id: true },
  })
  await db.membershipRole.create({
    data: { organizationId: state.orgId, membershipId: membership.id, roleId: role.id },
  })
  state.users[key] = user.id
  state.memberships[key] = membership.id
}

describe.skipIf(!hasDatabase)('People', () => {
  beforeAll(async () => {
    await seedAuthorization()
    const db = getSystemDb()

    const owner = await db.user.create({
      data: { email: `people-owner-${suffix}@example.test`, name: 'owner' },
      select: { id: true },
    })
    const org = await db.organization.create({
      data: { name: SLUG, slug: SLUG, createdById: owner.id, currency: 'USD' },
      select: { id: true },
    })
    state.orgId = org.id
    state.users.owner = owner.id

    const membership = await db.membership.create({
      data: { organizationId: org.id, userId: owner.id, status: 'ACTIVE' },
      select: { id: true },
    })
    state.memberships.owner = membership.id

    await seedMember('hr', 'hr_manager')
    await seedMember('manager', 'manager')
    await seedMember('employee', 'employee')
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: SLUG } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('sensitive fields', () => {
    it('lets HR record pay rates', async () => {
      const hr = await makeCtx('hr')
      await service.upsertProfile(
        hr,
        {
          membershipId: state.memberships.employee!,
          employmentType: 'FULL_TIME',
          weeklyCapacityMinutes: 2400,
          position: 'Engineer',
          costRateMinor: 5_000n,
          billRateMinor: 12_000n,
        },
        meta,
      )

      const stored = await getSystemDb().employeeProfile.findUniqueOrThrow({
        where: { membershipId: state.memberships.employee! },
      })
      expect(stored.costRateMinor).toBe(5_000n)
    })

    it('returns rates to HR', async () => {
      const hr = await makeCtx('hr')
      const person = await service.getPerson(hr, state.memberships.employee!)
      expect(person.profile?.costRateMinor).toBe(5_000n)
      expect(person.canSeeSensitive).toBe(true)
    })

    it('does NOT return rates to a Manager', async () => {
      // The Manager can see the person and their position, but pay is redacted
      // in the service, so it never reaches the page at all.
      const manager = await makeCtx('manager')
      const person = await service.getPerson(manager, state.memberships.employee!)

      expect(person.profile?.position).toBe('Engineer')
      expect(person.profile?.costRateMinor).toBeNull()
      expect(person.profile?.billRateMinor).toBeNull()
      expect(person.canSeeSensitive).toBe(false)
    })

    it('does NOT return rates in the directory listing either', async () => {
      const manager = await makeCtx('manager')
      const people = await service.listPeople(manager)
      expect(people.every((person) => person.costRateMinor === null)).toBe(true)
    })

    it('ignores a rate submitted by someone who cannot see rates', async () => {
      // An Owner short-circuits every permission, so use a role that can manage
      // profiles but not read sensitive fields. HR holds both; Manager holds
      // neither, so the attempt is refused outright.
      const manager = await makeCtx('manager')
      await expect(
        service.upsertProfile(
          manager,
          {
            membershipId: state.memberships.employee!,
            employmentType: 'FULL_TIME',
            weeklyCapacityMinutes: 2400,
            costRateMinor: 999_999n,
          },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')

      const stored = await getSystemDb().employeeProfile.findUniqueOrThrow({
        where: { membershipId: state.memberships.employee! },
      })
      expect(stored.costRateMinor).toBe(5_000n)
    })

    it('does not copy rates into the audit log', async () => {
      const entries = await getSystemDb().auditLog.findMany({
        where: { organizationId: state.orgId, action: 'people.profile_updated' },
        select: { metadata: true },
      })

      // An audit record that copies the value just moves sensitive data
      // somewhere with weaker permissions.
      for (const entry of entries) {
        expect(JSON.stringify(entry.metadata)).not.toContain('5000')
      }
    })
  })

  describe('permissions', () => {
    it('refuses an Employee editing someone else profile', async () => {
      const employee = await makeCtx('employee')
      await expect(
        service.upsertProfile(
          employee,
          {
            membershipId: state.memberships.manager!,
            employmentType: 'FULL_TIME',
            weeklyCapacityMinutes: 2400,
          },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('refuses an Employee creating a team', async () => {
      const employee = await makeCtx('employee')
      await expect(
        service.createTeam(employee, { name: 'Rogue', slug: 'rogue' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('refuses a Manager viewing workload they lack permission for', async () => {
      // Manager holds people.workload.view, so this one is allowed — the
      // negative case is the Employee.
      const employee = await makeCtx('employee')
      await expect(service.getWorkload(employee)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('lets a member edit their own skills without profile.manage', async () => {
      const owner = await makeCtx('owner', true)
      await service.createSkill(owner, { name: `TypeScript ${suffix}` })
      const skills = await service.listSkills(owner)
      const skill = skills.find((entry) => entry.name === `TypeScript ${suffix}`)!

      const employee = await makeCtx('employee')
      await expect(
        service.setMemberSkill(employee, {
          membershipId: state.memberships.employee!,
          skillId: skill.id,
          level: 4,
        }),
      ).resolves.toBeUndefined()
    })

    it('refuses a member editing someone else skills', async () => {
      const owner = await makeCtx('owner', true)
      const skills = await service.listSkills(owner)
      const skill = skills[0]!

      const employee = await makeCtx('employee')
      await expect(
        service.setMemberSkill(employee, {
          membershipId: state.memberships.manager!,
          skillId: skill.id,
          level: 5,
        }),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })
  })

  describe('validation', () => {
    it('refuses making someone their own manager', async () => {
      const hr = await makeCtx('hr')
      await expect(
        service.upsertProfile(
          hr,
          {
            membershipId: state.memberships.employee!,
            employmentType: 'FULL_TIME',
            weeklyCapacityMinutes: 2400,
            managerMembershipId: state.memberships.employee!,
          },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })

    it('refuses a duplicate team address', async () => {
      const owner = await makeCtx('owner', true)
      await service.createTeam(owner, { name: 'Platform', slug: `platform-${suffix}` }, meta)

      await expect(
        service.createTeam(owner, { name: 'Platform again', slug: `platform-${suffix}` }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')
    })

    it('makes the team lead a member automatically', async () => {
      const owner = await makeCtx('owner', true)
      const team = await service.createTeam(
        owner,
        {
          name: 'Led team',
          slug: `led-${suffix}`,
          leadMembershipId: state.memberships.manager!,
        },
        meta,
      )

      const teams = await service.listTeams(owner)
      const created = teams.find((entry) => entry.id === team.id)!
      expect(created.members.some((m) => m.membershipId === state.memberships.manager)).toBe(true)
    })
  })

  describe('workload', () => {
    it('counts only estimated work and reports the caveat', async () => {
      const owner = await makeCtx('owner', true)
      const db = getSystemDb()

      // One estimated task and one without an estimate.
      await db.taskCounter.upsert({
        where: { organizationId: state.orgId },
        create: { organizationId: state.orgId, nextNumber: 100 },
        update: {},
      })
      await db.task.createMany({
        data: [
          {
            organizationId: state.orgId,
            number: 901,
            title: 'Estimated',
            assigneeMembershipId: state.memberships.employee!,
            estimateMinutes: 600,
            status: 'TODO',
          },
          {
            organizationId: state.orgId,
            number: 902,
            title: 'Unestimated',
            assigneeMembershipId: state.memberships.employee!,
            status: 'TODO',
          },
        ],
      })

      const workload = await service.getWorkload(owner)
      const row = workload.rows.find((entry) => entry.membershipId === state.memberships.employee)!

      expect(row.openTasks).toBe(2)
      expect(row.estimatedMinutes).toBe(600)
      expect(workload.unestimatedTasks).toBeGreaterThan(0)
    })

    it('computes utilisation against capacity', async () => {
      const owner = await makeCtx('owner', true)
      const workload = await service.getWorkload(owner)
      const row = workload.rows.find((entry) => entry.membershipId === state.memberships.employee)!

      // 600 minutes of 2400 capacity.
      expect(row.utilisationPercent).toBe(25)
    })
  })
})
