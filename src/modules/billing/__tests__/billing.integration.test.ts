import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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
import * as organizations from '@/modules/organizations/service'
import * as projects from '@/modules/projects/service'

import { EntitlementError, hasCapacity, requireCapacity, usageFor } from '../entitlements'
import { setPaymentProvider, type PaymentProvider } from '../provider'
import * as service from '../service'

/**
 * Billing against a real database.
 *
 * The property this phase exists to guarantee: **nothing marks a subscription
 * paid except a verified provider event.** Plus the one that makes plans mean
 * anything — a limit is enforced on the server, before the operation, in the
 * service that performs it.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `billing-${suffix}`
const meta = { ip: null, userAgent: 'vitest-billing' }

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
      name: 'Billing Org',
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

/** A provider that records what it was asked for and never charges anything. */
function fakeProvider() {
  const checkouts: Array<{ planKey: string; organizationId: string }> = []

  const provider: PaymentProvider = {
    id: 'fake',
    async createCheckout(input) {
      checkouts.push({ planKey: input.planKey, organizationId: input.organizationId })
      return { url: 'https://provider.example/checkout/abc', providerSessionId: 'cs_test_1' }
    },
    async createPortalSession() {
      return { url: 'https://provider.example/portal/abc' }
    },
    verifyWebhook() {
      return null
    },
  }

  return { provider, checkouts }
}

describe.skipIf(!hasDatabase)('Billing', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const owner = await db.user.create({
      data: { email: `billing-owner-${suffix}@example.test`, name: 'owner' },
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

    await seedMember('manager', 'manager')
  })

  afterEach(() => {
    setPaymentProvider(undefined)
  })

  afterAll(async () => {
    if (!hasDatabase) return
    setPaymentProvider(undefined)
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: SLUG } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('defaults', () => {
    it('starts on the free plan with nothing recorded as paid', async () => {
      const ctx = await makeCtx('owner')
      const usage = await usageFor(ctx)

      expect(usage.plan.key).toBe('free')
      expect(usage.seats.used).toBe(2)
      expect(usage.seats.limit).toBe(10)
    })
  })

  describe('checkout changes nothing', () => {
    it('returns a URL and leaves the subscription untouched', async () => {
      const ctx = await makeCtx('owner')
      const { provider, checkouts } = fakeProvider()
      setPaymentProvider(provider)

      const result = await service.startCheckout(ctx, 'business', meta)
      expect(result.url).toContain('provider.example')
      expect(checkouts).toHaveLength(1)

      // The crucial assertion: the plan did NOT move. A redirect is not a
      // payment, and the organization is entitled to exactly what it was.
      const usage = await usageFor(ctx)
      expect(usage.plan.key).toBe('free')

      const subscription = await getSystemDb().subscription.findFirst({
        where: { organizationId: state.orgId },
        select: { status: true, plan: true },
      })
      expect(subscription?.status ?? 'NONE').toBe('NONE')
    })

    it('refuses checkout when no provider is configured', async () => {
      const ctx = await makeCtx('owner')
      setPaymentProvider(undefined)

      await expect(service.startCheckout(ctx, 'team', meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
    })

    it('refuses checkout to somebody without the billing permission', async () => {
      const manager = await makeCtx('manager')
      const { provider } = fakeProvider()
      setPaymentProvider(provider)

      expect(manager.can('organization.billing.manage')).toBe(false)

      await expect(service.startCheckout(manager, 'team', meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })
  })

  describe('setting a plan by hand', () => {
    it('is allowed only where no provider takes payments', async () => {
      const ctx = await makeCtx('owner')
      setPaymentProvider(undefined)

      await service.setPlanManually(ctx, 'business', meta)

      const usage = await usageFor(ctx)
      expect(usage.plan.key).toBe('business')

      const subscription = await getSystemDb().subscription.findFirstOrThrow({
        where: { organizationId: state.orgId },
        select: { setManuallyById: true, setManuallyAt: true, currentPeriodEnd: true },
      })

      // Recorded as a decision, not as an observed payment — and with no paid
      // period, because there is no payment behind it.
      expect(subscription.setManuallyById).toBe(state.users.owner)
      expect(subscription.setManuallyAt).not.toBeNull()
      expect(subscription.currentPeriodEnd).toBeNull()
    })

    it('is refused when a provider IS configured', async () => {
      const ctx = await makeCtx('owner')
      const { provider } = fakeProvider()
      setPaymentProvider(provider)

      // Otherwise this would be a way to grant paid features without paying.
      await expect(service.setPlanManually(ctx, 'business', meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
    })
  })

  describe('webhooks', () => {
    it('moves the plan only through a provider event', async () => {
      const ctx = await makeCtx('owner')
      setPaymentProvider(undefined)

      // Back to free, then link a provider customer as a checkout would.
      await service.setPlanManually(ctx, 'free', meta)
      await getSystemDb().subscription.updateMany({
        where: { organizationId: state.orgId },
        data: { providerCustomerId: `cus_${suffix}` },
      })

      const applied = await service.applyProviderEvent({
        id: `evt_${suffix}_1`,
        type: 'customer.subscription.updated',
        createdAt: null,
        data: {
          id: `sub_${suffix}`,
          customer: `cus_${suffix}`,
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
        },
      })

      expect(applied.applied).toBe(true)

      const subscription = await getSystemDb().subscription.findFirstOrThrow({
        where: { organizationId: state.orgId },
        select: { status: true, currentPeriodEnd: true, setManuallyAt: true },
      })

      expect(subscription.status).toBe('ACTIVE')
      expect(subscription.currentPeriodEnd).not.toBeNull()
      // A provider event supersedes a manual setting.
      expect(subscription.setManuallyAt).toBeNull()
    })

    it('ignores a repeated event, so a retry cannot undo a later change', async () => {
      const eventId = `evt_${suffix}_repeat`

      const first = await service.applyProviderEvent({
        id: eventId,
        type: 'customer.subscription.updated',
        createdAt: null,
        data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'active' },
      })

      const second = await service.applyProviderEvent({
        id: eventId,
        type: 'customer.subscription.updated',
        createdAt: null,
        data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'canceled' },
      })

      expect(first.applied).toBe(true)
      expect(second.applied).toBe(false)
      expect(second.reason).toContain('Already processed')

      // The cancellation in the REPEAT was not applied.
      const subscription = await getSystemDb().subscription.findFirstOrThrow({
        where: { organizationId: state.orgId },
        select: { status: true },
      })
      expect(subscription.status).toBe('ACTIVE')
    })

    /*
     * The two corrections from the production-hardening pass.
     *
     * Both are failure modes that idempotency-by-event-id does NOT cover, and
     * both would have been invisible: the subscription would simply have held
     * the wrong state, with no error anywhere.
     */

    it('lets the provider retry an event whose first attempt failed', async () => {
      const eventId = `evt_${suffix}_retry`

      // A failure inside handling. The route answers 500 to ask for a retry,
      // which is only worth asking for if the retry can actually succeed.
      const failure = new Error('database unavailable')
      const spy = vi
        .spyOn(getSystemDb().subscription, 'findUnique')
        .mockRejectedValueOnce(failure as never)

      await expect(
        service.applyProviderEvent({
          id: eventId,
          type: 'customer.subscription.updated',
          createdAt: null,
          data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'past_due' },
        }),
      ).rejects.toThrow('database unavailable')

      spy.mockRestore()

      // The retry the 500 asked for. Before this fix it was refused as
      // "already processed" and the event was lost for good.
      const retry = await service.applyProviderEvent({
        id: eventId,
        type: 'customer.subscription.updated',
        createdAt: null,
        data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'past_due' },
      })

      expect(retry.applied).toBe(true)

      const subscription = await getSystemDb().subscription.findFirstOrThrow({
        where: { organizationId: state.orgId },
        select: { status: true },
      })
      expect(subscription.status).toBe('PAST_DUE')

      // And the attempt count records that it took two goes.
      const row = await getSystemDb().billingEvent.findUniqueOrThrow({
        where: { providerEventId: eventId },
        select: { attempts: true, processedAt: true },
      })
      expect(row.attempts).toBe(2)
      expect(row.processedAt).not.toBeNull()
    })

    it('refuses state older than what has already been applied', async () => {
      const cancelledAt = new Date('2026-06-01T12:00:00Z')
      const staleUpdateAt = new Date('2026-06-01T11:59:00Z')

      // The subscription is cancelled.
      await service.applyProviderEvent({
        id: `evt_${suffix}_order_cancel`,
        type: 'customer.subscription.deleted',
        createdAt: cancelledAt,
        data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'canceled' },
      })

      expect(
        (
          await getSystemDb().subscription.findFirstOrThrow({
            where: { organizationId: state.orgId },
            select: { status: true },
          })
        ).status,
      ).toBe('CANCELED')

      // Now an OLDER "active" arrives — a different event, delivered late after
      // a provider-side retry. Idempotency by id does not help: it has never
      // been seen before, and it is processed exactly once. Only the timestamp
      // says it must not win.
      const late = await service.applyProviderEvent({
        id: `evt_${suffix}_order_stale`,
        type: 'customer.subscription.updated',
        createdAt: staleUpdateAt,
        data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'active' },
      })

      expect(late.applied).toBe(true) // recorded against the organization
      expect(
        (
          await getSystemDb().subscription.findFirstOrThrow({
            where: { organizationId: state.orgId },
            select: { status: true },
          })
        ).status,
        'a late retry reactivated a cancelled subscription',
      ).toBe('CANCELED')
    })

    it('still applies genuinely newer state', async () => {
      const laterAt = new Date('2026-06-02T09:00:00Z')

      await service.applyProviderEvent({
        id: `evt_${suffix}_order_new`,
        type: 'customer.subscription.updated',
        createdAt: laterAt,
        data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'active' },
      })

      expect(
        (
          await getSystemDb().subscription.findFirstOrThrow({
            where: { organizationId: state.orgId },
            select: { status: true },
          })
        ).status,
      ).toBe('ACTIVE')
    })

    it('ignores an event for a customer this deployment has never seen', async () => {
      const result = await service.applyProviderEvent({
        id: `evt_${suffix}_stranger`,
        type: 'customer.subscription.updated',
        createdAt: null,
        data: { id: 'sub_other', customer: 'cus_someone_else', status: 'active' },
      })

      expect(result.applied).toBe(false)
    })

    it('a cancellation returns the organization to free-tier limits', async () => {
      await service.applyProviderEvent({
        id: `evt_${suffix}_cancel`,
        type: 'customer.subscription.deleted',
        createdAt: null,
        data: { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: 'canceled' },
      })

      const ctx = await makeCtx('owner')
      const usage = await usageFor(ctx)

      expect(usage.plan.key).toBe('free')
      expect(usage.seats.limit).toBe(10)
    })
  })

  describe('limits are enforced on the server', () => {
    it('refuses an invitation that would exceed the seat limit', async () => {
      const ctx = await makeCtx('owner')
      setPaymentProvider(undefined)
      await service.setPlanManually(ctx, 'free', meta)

      // Free allows ten; two exist. Fill the remaining eight.
      const db = getSystemDb()
      for (let index = 0; index < 8; index += 1) {
        const filler = await db.user.create({
          data: { email: `filler-${index}-${suffix}@example.test`, name: `filler ${index}` },
          select: { id: true },
        })
        await db.membership.create({
          data: { organizationId: state.orgId, userId: filler.id, status: 'ACTIVE' },
        })
        state.users[`filler${index}`] = filler.id
      }

      const fresh = await makeCtx('owner')
      expect(await hasCapacity(fresh, 'seats')).toBe(false)

      await expect(
        organizations.inviteMember(fresh, { email: `one-too-many-${suffix}@example.test` }, meta),
      ).rejects.toBeInstanceOf(EntitlementError)

      // And nothing was written: refusing after the fact is not a limit.
      const invitations = await db.invitation.count({ where: { organizationId: state.orgId } })
      expect(invitations).toBe(0)
    })

    it('refuses a project that would exceed the project limit', async () => {
      const ctx = await makeCtx('owner')
      setPaymentProvider(undefined)
      await service.setPlanManually(ctx, 'free', meta)

      const db = getSystemDb()
      for (let index = 0; index < 10; index += 1) {
        await db.project.create({
          data: {
            organizationId: state.orgId,
            key: `P${index}${suffix.slice(-3)}`,
            name: `Project ${index}`,
            status: 'ACTIVE',
            currency: 'USD',
          },
        })
      }

      const fresh = await makeCtx('owner')
      await expect(
        projects.createProject(
          fresh,
          {
            key: 'OVER',
            name: 'One too many',
            status: 'ACTIVE',
            priority: 'MEDIUM',
            visibility: 'ORGANIZATION',
          },
          meta,
        ),
      ).rejects.toBeInstanceOf(EntitlementError)
    })

    it('allows the operation again once the plan is larger', async () => {
      const ctx = await makeCtx('owner')
      setPaymentProvider(undefined)
      await service.setPlanManually(ctx, 'business', meta)

      const fresh = await makeCtx('owner')
      expect(await hasCapacity(fresh, 'seats')).toBe(true)
      await expect(requireCapacity(fresh, 'projects')).resolves.toBeUndefined()
    })

    it('counts the size of an upload before storing it', async () => {
      const ctx = await makeCtx('owner')
      setPaymentProvider(undefined)
      await service.setPlanManually(ctx, 'free', meta)

      const fresh = await makeCtx('owner')
      // Three gigabytes against a two-gigabyte allowance, checked before any
      // bytes are written.
      const overLimit = 3 * 1024 * 1024 * 1024
      await expect(requireCapacity(fresh, 'storageBytes', overLimit)).rejects.toBeInstanceOf(
        EntitlementError,
      )
    })
  })
})
