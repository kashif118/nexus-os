import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

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
import { drainOutbox, emitEvent, registerSubscriber, resetSubscribers } from '@/kernel/events'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb } from '@/lib/db'
import { setMailer } from '@/lib/email/mailer'

import { activitySubscriber } from '../activity-subscriber'
import * as service from '../service'
import { notificationSubscriber } from '../subscriber'

/**
 * The outbox, against a real database.
 *
 * The properties that make an outbox worth having, each asserted rather than
 * assumed:
 *
 * - an event emitted inside a transaction that rolls back is never delivered;
 * - a second drain does not deliver the same event to the same subscriber twice;
 * - one failing subscriber does not stop the others;
 * - a poison event stops being retried instead of looping;
 * - notifications land on the right people, never on the actor;
 * - a member cannot read another member's notifications.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `events-${suffix}`

const state = {
  orgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

async function makeCtx(key: string): Promise<Ctx> {
  const membershipId = state.memberships[key]!
  const isOwner = key === 'owner'
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
      name: 'Events Org',
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

describe.skipIf(!hasDatabase)('Outbox and notifications', () => {
  beforeAll(async () => {
    await seedAuthorization()
    const db = getSystemDb()

    const owner = await db.user.create({
      data: { email: `events-owner-${suffix}@example.test`, name: 'owner' },
      select: { id: true },
    })
    const org = await db.organization.create({
      data: { name: SLUG, slug: SLUG, createdById: owner.id },
      select: { id: true },
    })
    state.orgId = org.id
    state.users.owner = owner.id

    const membership = await db.membership.create({
      data: { organizationId: org.id, userId: owner.id, status: 'ACTIVE' },
      select: { id: true },
    })
    state.memberships.owner = membership.id

    await seedMember('alice', 'manager')
    await seedMember('bob', 'employee')

    // Email goes to a recorder rather than the console transport.
    setMailer({ async send() {} })
  })

  afterEach(() => {
    resetSubscribers()
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: SLUG } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('transactional guarantee', () => {
    it('does not deliver an event whose transaction rolled back', async () => {
      const seen: string[] = []
      registerSubscriber({
        name: 'recorder',
        async handle(event) {
          seen.push(event.id)
        },
      })

      const db = getSystemDb()

      await expect(
        db.$transaction(async (tx) => {
          await emitEvent(
            {
              type: 'task.assigned',
              organizationId: state.orgId,
              entityType: 'Task',
              entityId: 'task-rolled-back',
              payload: { assigneeMembershipId: state.memberships.bob },
            },
            tx as never,
          )

          throw new Error('the change failed after the event was written')
        }),
      ).rejects.toThrow('the change failed')

      await drainOutbox()

      // No event row survived, so nobody was told about something that did not
      // happen. This is the whole point of an outbox.
      expect(seen).toEqual([])

      const orphan = await db.outboxEvent.findFirst({
        where: { entityId: 'task-rolled-back' },
        select: { id: true },
      })
      expect(orphan).toBeNull()
    })
  })

  describe('idempotency', () => {
    it('delivers an event to a subscriber exactly once across repeated drains', async () => {
      let calls = 0
      registerSubscriber({
        name: 'counter',
        async handle() {
          calls += 1
        },
      })

      await emitEvent({
        type: 'member.joined',
        organizationId: state.orgId,
        entityType: 'Membership',
        entityId: state.memberships.bob!,
        payload: { name: 'bob' },
      })

      await drainOutbox()
      await drainOutbox()
      await drainOutbox()

      expect(calls).toBe(1)
    })

    it('isolates a failing subscriber from a healthy one', async () => {
      let healthy = 0

      registerSubscriber({
        name: 'healthy',
        async handle() {
          healthy += 1
        },
      })
      registerSubscriber({
        name: 'broken',
        async handle() {
          throw new Error('subscriber exploded')
        },
      })

      await emitEvent({
        type: 'member.joined',
        organizationId: state.orgId,
        entityType: 'Membership',
        entityId: `isolation-${suffix}`,
        payload: { name: 'bob' },
      })

      const result = await drainOutbox()

      expect(healthy).toBe(1)
      expect(result.failed).toBe(1)

      const deliveries = await getSystemDb().outboxDelivery.findMany({
        where: { event: { entityId: `isolation-${suffix}` } },
        select: { subscriber: true, status: true },
      })

      expect(deliveries).toContainEqual({ subscriber: 'healthy', status: 'DELIVERED' })
      expect(deliveries).toContainEqual({ subscriber: 'broken', status: 'FAILED' })
    })

    it('stops retrying a poison event instead of looping forever', async () => {
      let attempts = 0
      const poisonId = `poison-${suffix}`

      registerSubscriber({
        name: 'always-fails',
        async handle(event) {
          // The drain also carries the backlog from earlier tests; only this
          // event is under test.
          if (event.entityId !== poisonId) return
          attempts += 1
          throw new Error('nope')
        },
      })

      await emitEvent({
        type: 'member.joined',
        organizationId: state.orgId,
        entityType: 'Membership',
        entityId: poisonId,
        payload: { name: 'bob' },
      })

      for (let index = 0; index < 8; index += 1) {
        await drainOutbox()
      }

      // Five attempts is the cap; the ninth drain must not call it again.
      expect(attempts).toBeLessThanOrEqual(5)
    })
  })

  describe('notification fan-out', () => {
    it('notifies the assignee and not the person who assigned it', async () => {
      registerSubscriber(notificationSubscriber)

      await emitEvent({
        type: 'task.assigned',
        organizationId: state.orgId,
        entityType: 'Task',
        entityId: `fanout-${suffix}`,
        actorId: state.users.alice!,
        payload: {
          actorName: 'alice',
          actorMembershipId: state.memberships.alice,
          assigneeMembershipId: state.memberships.bob,
          title: 'Write the report',
        },
      })

      await drainOutbox()

      const bob = await makeCtx('bob')
      const alice = await makeCtx('alice')

      const bobsNotifications = await service.listNotifications(bob)
      const alicesNotifications = await service.listNotifications(alice)

      expect(bobsNotifications.map((row) => row.title)).toContain(
        'alice assigned you "Write the report"',
      )
      expect(alicesNotifications).toHaveLength(0)
    })

    it('respects a preference that turns the notification off', async () => {
      registerSubscriber(notificationSubscriber)

      const bob = await makeCtx('bob')
      await service.updatePreference(bob, {
        eventType: 'task.assigned',
        inApp: false,
        email: false,
        digest: false,
      })

      const before = (await service.listNotifications(bob)).length

      await emitEvent({
        type: 'task.assigned',
        organizationId: state.orgId,
        entityType: 'Task',
        entityId: `muted-${suffix}`,
        actorId: state.users.alice!,
        payload: {
          actorName: 'alice',
          actorMembershipId: state.memberships.alice,
          assigneeMembershipId: state.memberships.bob,
          title: 'Muted task',
        },
      })

      await drainOutbox()

      const after = await service.listNotifications(bob)
      expect(after).toHaveLength(before)
      expect(after.map((row) => row.title)).not.toContain('alice assigned you "Muted task"')

      // Put it back for any later test.
      await service.updatePreference(bob, {
        eventType: 'task.assigned',
        inApp: true,
        email: false,
        digest: false,
      })
    })

    it('writes an activity entry even when nobody is notified', async () => {
      registerSubscriber(activitySubscriber)

      await emitEvent({
        type: 'deal.stage.changed',
        organizationId: state.orgId,
        entityType: 'Deal',
        entityId: `activity-${suffix}`,
        actorId: state.users.alice!,
        payload: { actorName: 'alice', title: 'Big deal', stageName: 'Negotiation' },
      })

      await drainOutbox()

      const alice = await makeCtx('alice')
      const activity = await service.listActivity(alice, {
        entityType: 'Deal',
        entityId: `activity-${suffix}`,
      })

      expect(activity).toHaveLength(1)
      expect(activity[0]?.verb).toBe('stage changed')
      expect(activity[0]?.summary).toContain('Big deal')
    })
  })

  describe('privacy', () => {
    it('does not let one member read another member’s notifications', async () => {
      registerSubscriber(notificationSubscriber)

      await emitEvent({
        type: 'task.assigned',
        organizationId: state.orgId,
        entityType: 'Task',
        entityId: `private-${suffix}`,
        actorId: state.users.alice!,
        payload: {
          actorName: 'alice',
          actorMembershipId: state.memberships.alice,
          assigneeMembershipId: state.memberships.bob,
          title: 'Confidential briefing',
        },
      })

      await drainOutbox()

      const owner = await makeCtx('owner')
      const ownersNotifications = await service.listNotifications(owner)

      // The owner can do everything else in this organization, and still cannot
      // see somebody else's notifications: there is no permission that grants it.
      expect(ownersNotifications.map((row) => row.title)).not.toContain(
        'alice assigned you "Confidential briefing"',
      )
    })

    it('marking read only affects your own rows', async () => {
      registerSubscriber(notificationSubscriber)

      await emitEvent({
        type: 'task.assigned',
        organizationId: state.orgId,
        entityType: 'Task',
        entityId: `markread-${suffix}`,
        actorId: state.users.alice!,
        payload: {
          actorName: 'alice',
          actorMembershipId: state.memberships.alice,
          assigneeMembershipId: state.memberships.bob,
          title: 'Read me',
        },
      })

      await drainOutbox()

      const bob = await makeCtx('bob')
      const owner = await makeCtx('owner')

      const bobsRow = (await service.listNotifications(bob)).find(
        (row) => row.title === 'alice assigned you "Read me"',
      )
      expect(bobsRow).toBeDefined()

      // The owner tries to mark Bob's notification read by id.
      const changed = await service.markRead(owner, [bobsRow!.id])
      expect(changed).toBe(0)

      const stillUnread = await service.countUnread(bob)
      expect(stillUnread).toBeGreaterThan(0)
    })
  })
})
