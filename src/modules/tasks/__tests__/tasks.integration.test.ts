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

import { extractMentions } from '../service'
import * as service from '../service'

/**
 * Tasks against a real database.
 *
 * The parts worth proving with real Postgres: number allocation under
 * concurrency, dependency blocking, cycle rejection across a persisted graph,
 * and that completing tasks actually moves project progress and health.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG_A = `task-a-${suffix}`
const SLUG_B = `task-b-${suffix}`
const meta = { ip: null, userAgent: 'vitest-tasks' }

const state = {
  orgA: '',
  orgB: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
  projectA: '',
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
      name: 'Tasks',
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

const base = { status: 'BACKLOG', priority: 'MEDIUM' }

/**
 * Lift the plan limits for this suite.
 *
 * These tests exercise breadth — many projects, many members — rather than
 * entitlements, and the free tier is deliberately small. Saying so here keeps
 * the limit real everywhere else instead of weakening it for everybody.
 */
async function grantUnlimitedPlan(organizationId: string): Promise<void> {
  await getSystemDb().subscription.upsert({
    where: { organizationId },
    create: { organizationId, plan: 'business', status: 'ACTIVE' },
    update: { plan: 'business', status: 'ACTIVE' },
  })
}

describe.skipIf(!hasDatabase)('Tasks', () => {
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
      await grantUnlimitedPlan(org.id)
      const membership = await db.membership.create({
        data: { organizationId: org.id, userId: user.id, status: 'ACTIVE' },
        select: { id: true },
      })
      state.users[key] = user.id
      state.memberships[key] = membership.id
      if (key === 'ownerA') state.orgA = org.id
      else state.orgB = org.id
    }

    await seedMember(state.orgA, 'employee', 'employee')

    const project = await db.project.create({
      data: {
        organizationId: state.orgA,
        key: 'TSK',
        name: 'Task project',
        currency: 'USD',
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    state.projectA = project.id
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('numbering', () => {
    it('numbers tasks sequentially from one', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const first = await service.createTask(ctx, { ...base, title: 'First' }, meta)
      const second = await service.createTask(ctx, { ...base, title: 'Second' }, meta)

      expect(first.number).toBe(1)
      expect(second.number).toBe(2)
    })

    it('never issues the same number twice under concurrency', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)

      // The real test of the atomic counter: read-then-write would collide here.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          service.createTask(ctx, { ...base, title: `Concurrent ${index}` }, meta),
        ),
      )

      const numbers = results.map((result) => result.number)
      expect(new Set(numbers).size).toBe(numbers.length)
    })

    it('numbers each organization independently', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const first = await service.createTask(ctxB, { ...base, title: 'B first' }, meta)
      expect(first.number).toBe(1)
    })
  })

  describe('permissions', () => {
    it('lets an Employee create a task', async () => {
      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(
        service.createTask(ctx, { ...base, title: 'Employee task' }, meta),
      ).resolves.toBeTruthy()
    })

    it('refuses an Employee deleting a task', async () => {
      const owner = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const task = await service.createTask(owner, { ...base, title: 'Delete me' }, meta)

      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(service.deleteTask(ctx, task.id, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses an Employee editing a task that is not theirs', async () => {
      const owner = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const task = await service.createTask(owner, { ...base, title: 'Not yours' }, meta)

      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(
        service.updateTask(ctx, task.id, { ...base, title: 'Hijacked' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('lets an Employee edit a task assigned to them', async () => {
      const owner = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const task = await service.createTask(
        owner,
        { ...base, title: 'Assigned', assigneeMembershipId: state.memberships.employee },
        meta,
      )

      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(
        service.updateTask(
          ctx,
          task.id,
          {
            ...base,
            title: 'Updated by assignee',
            assigneeMembershipId: state.memberships.employee,
          },
          meta,
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe('dependencies', () => {
    it('blocks starting a task whose prerequisite is open', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const blocker = await service.createTask(ctx, { ...base, title: 'Design' }, meta)
      const blocked = await service.createTask(ctx, { ...base, title: 'Build' }, meta)

      await service.addDependency(
        ctx,
        { taskId: blocked.id, dependsOnTaskId: blocker.id, type: 'FINISH_START' },
        meta,
      )

      await expect(
        service.moveTask(ctx, { taskId: blocked.id, status: 'IN_PROGRESS' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && /blocked by/i.test(error.message))
    })

    it('names the blocking task in the message', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const blocker = await service.createTask(ctx, { ...base, title: 'Specification' }, meta)
      const blocked = await service.createTask(ctx, { ...base, title: 'Implementation' }, meta)
      await service.addDependency(
        ctx,
        { taskId: blocked.id, dependsOnTaskId: blocker.id, type: 'FINISH_START' },
        meta,
      )

      try {
        await service.moveTask(ctx, { taskId: blocked.id, status: 'IN_PROGRESS' }, meta)
        expect.unreachable()
      } catch (error) {
        expect(isAppError(error) && error.message).toContain('Specification')
      }
    })

    it('allows the move once the prerequisite is done', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const blocker = await service.createTask(ctx, { ...base, title: 'Prereq' }, meta)
      const blocked = await service.createTask(ctx, { ...base, title: 'Dependent' }, meta)
      await service.addDependency(
        ctx,
        { taskId: blocked.id, dependsOnTaskId: blocker.id, type: 'FINISH_START' },
        meta,
      )

      await service.moveTask(ctx, { taskId: blocker.id, status: 'DONE' }, meta)
      await expect(
        service.moveTask(ctx, { taskId: blocked.id, status: 'IN_PROGRESS' }, meta),
      ).resolves.toBeUndefined()
    })

    it('rejects a self-dependency', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const task = await service.createTask(ctx, { ...base, title: 'Self' }, meta)

      await expect(
        service.addDependency(
          ctx,
          { taskId: task.id, dependsOnTaskId: task.id, type: 'FINISH_START' },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })

    it('rejects a cycle across a persisted chain', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const a = await service.createTask(ctx, { ...base, title: 'Cycle A' }, meta)
      const b = await service.createTask(ctx, { ...base, title: 'Cycle B' }, meta)
      const c = await service.createTask(ctx, { ...base, title: 'Cycle C' }, meta)

      await service.addDependency(
        ctx,
        { taskId: b.id, dependsOnTaskId: a.id, type: 'FINISH_START' },
        meta,
      )
      await service.addDependency(
        ctx,
        { taskId: c.id, dependsOnTaskId: b.id, type: 'FINISH_START' },
        meta,
      )

      // a depends on c would close the loop a → c → b → a.
      await expect(
        service.addDependency(
          ctx,
          { taskId: a.id, dependsOnTaskId: c.id, type: 'FINISH_START' },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')
    })

    it('always allows moving a blocked task back to the backlog', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const blocker = await service.createTask(ctx, { ...base, title: 'Still open' }, meta)
      const blocked = await service.createTask(
        ctx,
        { ...base, title: 'Retreating', status: 'TODO' },
        meta,
      )
      await service.addDependency(
        ctx,
        { taskId: blocked.id, dependsOnTaskId: blocker.id, type: 'FINISH_START' },
        meta,
      )

      await expect(
        service.moveTask(ctx, { taskId: blocked.id, status: 'BACKLOG' }, meta),
      ).resolves.toBeUndefined()
    })
  })

  describe('tenant isolation', () => {
    it('cannot read a task from another organization', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const task = await service.createTask(ctxB, { ...base, title: 'Org B task' }, meta)

      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(service.getTask(ctxA, task.id)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('cannot depend on a task from another organization', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const foreign = await service.createTask(ctxB, { ...base, title: 'Foreign' }, meta)

      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const mine = await service.createTask(ctxA, { ...base, title: 'Mine' }, meta)

      await expect(
        service.addDependency(
          ctxA,
          { taskId: mine.id, dependsOnTaskId: foreign.id, type: 'FINISH_START' },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'NOT_FOUND')
    })

    it('cannot assign a task to a member of another organization', async () => {
      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(
        service.createTask(
          ctxA,
          { ...base, title: 'Bad assignee', assigneeMembershipId: state.memberships.ownerB },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })
  })

  describe('project progress', () => {
    it('moves project progress as tasks complete', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)

      const one = await service.createTask(
        ctx,
        { ...base, title: 'Project task 1', projectId: state.projectA },
        meta,
      )
      await service.createTask(
        ctx,
        { ...base, title: 'Project task 2', projectId: state.projectA },
        meta,
      )

      const before = await getSystemDb().project.findUniqueOrThrow({
        where: { id: state.projectA },
        select: { progressPercent: true },
      })
      expect(before.progressPercent).toBe(0)

      await service.moveTask(ctx, { taskId: one.id, status: 'DONE' }, meta)

      const after = await getSystemDb().project.findUniqueOrThrow({
        where: { id: state.projectA },
        select: { progressPercent: true },
      })
      expect(after.progressPercent).toBe(50)
    })

    it('degrades project health when tasks go overdue', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)

      await service.createTask(
        ctx,
        {
          ...base,
          title: 'Late task',
          projectId: state.projectA,
          dueDate: new Date('2020-01-01'),
        },
        meta,
      )

      const project = await getSystemDb().project.findUniqueOrThrow({
        where: { id: state.projectA },
        select: { healthScore: true },
      })
      expect(project.healthScore).toBeLessThan(100)
    })
  })

  describe('comments and mentions', () => {
    it('records a comment', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const task = await service.createTask(ctx, { ...base, title: 'Discussed' }, meta)

      await service.addComment(ctx, { taskId: task.id, body: 'Looks good to me.' }, meta)

      const detail = await service.getTask(ctx, task.id)
      expect(detail.comments).toHaveLength(1)
      expect(detail.comments[0]?.body).toBe('Looks good to me.')
    })

    it('links a mention to a member of this organization', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const task = await service.createTask(ctx, { ...base, title: 'Mentioned' }, meta)

      await service.addComment(ctx, { taskId: task.id, body: 'cc @employee please' }, meta)

      const mentions = await getSystemDb().commentMention.findMany({
        where: { organizationId: state.orgA, mentionedMembershipId: state.memberships.employee },
      })
      expect(mentions.length).toBeGreaterThan(0)
    })

    it('ignores a mention of someone outside the organization', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const task = await service.createTask(ctx, { ...base, title: 'Foreign mention' }, meta)

      await service.addComment(ctx, { taskId: task.id, body: 'cc @ownerB hello' }, meta)

      const mentions = await getSystemDb().commentMention.findMany({
        where: { mentionedMembershipId: state.memberships.ownerB },
      })
      expect(mentions).toHaveLength(0)
    })
  })

  describe('extractMentions', () => {
    it('finds a single-word mention', () => {
      expect(extractMentions('hey @ada look')).toEqual(['ada'])
    })

    it('takes only the first token, so ordinary prose is not swallowed', () => {
      // Guessing where a name ends in free text is not solvable; multi-word
      // names need a mention picker.
      expect(extractMentions('@Ada Lovelace please review')).toEqual(['Ada'])
    })

    it('deduplicates', () => {
      expect(extractMentions('@ada and @ada')).toEqual(['ada'])
    })

    it('returns nothing when there are no mentions', () => {
      expect(extractMentions('no mentions here')).toEqual([])
    })

    it('ignores a bare at sign followed by a space', () => {
      expect(extractMentions('email me @ work')).toEqual([])
    })

    it('ignores an email address, which is not a mention', () => {
      expect(extractMentions('write to ada@example.test')).toEqual(['example.test'])
    })
  })
})
