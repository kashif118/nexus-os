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

import * as service from '../service'
import { COMPANY_SORT_FIELDS } from '../schema'

/**
 * CRM against a real database.
 *
 * Covers the three things that actually matter: permissions are enforced by the
 * service (not the UI), records cannot cross tenants, and lead conversion
 * produces the linked records it promises without destroying the lead.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG_A = `crm-a-${suffix}`
const SLUG_B = `crm-b-${suffix}`

const meta = { ip: null, userAgent: 'vitest-crm' }

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
    sessionId: `session-${key}`,
    orgId,
    orgSlug,
    membershipId,
    isOwner,
    user: { id: state.users[key]!, name: key, email: `${key}@example.test`, emailVerifiedAt: null },
    org: {
      id: orgId,
      slug: orgSlug,
      name: 'CRM Org',
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

const listParams = parseListParams({}, { sortableFields: COMPANY_SORT_FIELDS, defaultSort: 'name' })

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

describe.skipIf(!hasDatabase)('CRM', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const ownerA = await db.user.create({
      data: { email: `crm-owner-a-${suffix}@example.test`, name: 'ownerA' },
      select: { id: true },
    })
    const ownerB = await db.user.create({
      data: { email: `crm-owner-b-${suffix}@example.test`, name: 'ownerB' },
      select: { id: true },
    })

    const orgA = await db.organization.create({
      data: { name: 'Org A', slug: SLUG_A, createdById: ownerA.id, currency: 'USD' },
      select: { id: true },
    })
    const orgB = await db.organization.create({
      data: { name: 'Org B', slug: SLUG_B, createdById: ownerB.id, currency: 'USD' },
      select: { id: true },
    })
    state.orgA = orgA.id
    await grantUnlimitedPlan(orgA.id)
    await grantUnlimitedPlan(orgB.id)
    state.orgB = orgB.id

    state.users.ownerA = ownerA.id
    state.users.ownerB = ownerB.id

    const membershipA = await db.membership.create({
      data: { organizationId: orgA.id, userId: ownerA.id, status: 'ACTIVE' },
      select: { id: true },
    })
    const membershipB = await db.membership.create({
      data: { organizationId: orgB.id, userId: ownerB.id, status: 'ACTIVE' },
      select: { id: true },
    })
    state.memberships.ownerA = membershipA.id
    state.memberships.ownerB = membershipB.id

    await seedMember(orgA.id, 'manager', 'manager')
    await seedMember(orgA.id, 'employee', 'employee')
    await seedMember(orgA.id, 'finance', 'finance_manager')
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('permissions', () => {
    it('lets a Manager create a company', async () => {
      const ctx = await makeCtx('manager', state.orgA, SLUG_A)
      const company = await service.createCompany(ctx, { name: 'Acme Manager' }, meta)
      expect(company.id).toBeTruthy()
    })

    it('refuses an Employee creating a company', async () => {
      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(service.createCompany(ctx, { name: 'Nope' }, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses an Employee reading companies', async () => {
      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(service.listCompanies(ctx, listParams)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('lets a Finance Manager read companies but not create them', async () => {
      const ctx = await makeCtx('finance', state.orgA, SLUG_A)
      await expect(service.listCompanies(ctx, listParams)).resolves.toBeTruthy()
      await expect(service.createCompany(ctx, { name: 'Nope' }, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('refuses an Employee deleting a company', async () => {
      const owner = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const company = await service.createCompany(owner, { name: 'Delete target' }, meta)

      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(service.deleteCompany(ctx, company.id, meta)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })
  })

  describe('tenant isolation', () => {
    it('cannot read a company from another organization', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const company = await service.createCompany(ctxB, { name: 'Org B Secret' }, meta)

      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(service.getCompany(ctxA, company.id)).rejects.toSatisfy(
        (error) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })

    it('cannot update a company from another organization', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const company = await service.createCompany(ctxB, { name: 'Org B Target' }, meta)

      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(
        service.updateCompany(ctxA, company.id, { name: 'Hijacked' }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'NOT_FOUND')

      const unchanged = await getSystemDb().company.findUniqueOrThrow({ where: { id: company.id } })
      expect(unchanged.name).toBe('Org B Target')
    })

    it('does not list another organization companies', async () => {
      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const page = await service.listCompanies(ctxA, listParams)
      expect(page.items.every((item) => !item.name.startsWith('Org B'))).toBe(true)
    })

    it('refuses to link a contact to a company in another organization', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const companyB = await service.createCompany(ctxB, { name: 'Org B Co' }, meta)

      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(
        service.createContact(
          ctxA,
          { firstName: 'Cross', lastName: 'Tenant', companyId: companyB.id },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })

    it('refuses to assign an owner from another organization', async () => {
      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(
        service.createCompany(
          ctxA,
          { name: 'Bad owner', ownerMembershipId: state.memberships.ownerB },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })

    it('refuses to attach an activity to a record in another organization', async () => {
      const ctxB = await makeCtx('ownerB', state.orgB, SLUG_B, true)
      const companyB = await service.createCompany(ctxB, { name: 'Org B Activity' }, meta)

      const ctxA = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await expect(
        service.logActivity(
          ctxA,
          { type: 'NOTE', subject: 'Snooping', entityType: 'Company', entityId: companyB.id },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'NOT_FOUND')
    })
  })

  describe('pipelines and deals', () => {
    it('creates a default pipeline on first use', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const pipeline = await service.ensureDefaultPipeline(ctx)
      expect(pipeline?.stages.length).toBeGreaterThan(0)
    })

    it('is idempotent', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await service.ensureDefaultPipeline(ctx)
      const pipelines = await service.listPipelines(ctx)
      expect(pipelines).toHaveLength(1)
    })

    it('records a stage change with its duration', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const pipeline = await service.ensureDefaultPipeline(ctx)
      const [first, second] = pipeline!.stages

      const deal = await service.createDeal(
        ctx,
        {
          title: 'Velocity deal',
          pipelineId: pipeline!.id,
          stageId: first!.id,
          valueMinor: 500_00n,
        },
        meta,
      )

      await service.moveDeal(ctx, { dealId: deal.id, stageId: second!.id }, meta)

      const detail = await service.getDeal(ctx, deal.id)
      expect(detail.stage.id).toBe(second!.id)
      expect(detail.history.length).toBe(2)
      expect(detail.history[0]?.durationSeconds).not.toBeNull()
    })

    it('marks a deal won when it reaches a WON stage', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const pipeline = await service.ensureDefaultPipeline(ctx)
      const wonStage = pipeline!.stages.find((stage) => stage.type === 'WON')!

      const deal = await service.createDeal(
        ctx,
        {
          title: 'Winning deal',
          pipelineId: pipeline!.id,
          stageId: pipeline!.stages[0]!.id,
          valueMinor: 1_000_00n,
        },
        meta,
      )

      await service.moveDeal(ctx, { dealId: deal.id, stageId: wonStage.id }, meta)

      const detail = await service.getDeal(ctx, deal.id)
      expect(detail.status).toBe('WON')
      expect(detail.wonAt).not.toBeNull()
    })

    it('refuses a stage from a different pipeline', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const pipeline = await service.ensureDefaultPipeline(ctx)

      const other = await getSystemDb().pipeline.create({
        data: { organizationId: state.orgA, name: `Other ${suffix}` },
        select: { id: true },
      })
      const otherStage = await getSystemDb().pipelineStage.create({
        data: { organizationId: state.orgA, pipelineId: other.id, name: 'Alt', position: 0 },
        select: { id: true },
      })

      await expect(
        service.createDeal(
          ctx,
          {
            title: 'Mismatched',
            pipelineId: pipeline!.id,
            stageId: otherStage.id,
            valueMinor: 0n,
          },
          meta,
        ),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'VALIDATION_ERROR')
    })

    it('stores deal value exactly, with no float drift', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const pipeline = await service.ensureDefaultPipeline(ctx)

      const deal = await service.createDeal(
        ctx,
        {
          title: 'Exact value',
          pipelineId: pipeline!.id,
          stageId: pipeline!.stages[0]!.id,
          valueMinor: 1234567890123n,
        },
        meta,
      )

      const stored = await getSystemDb().deal.findUniqueOrThrow({ where: { id: deal.id } })
      expect(stored.valueMinor).toBe(1234567890123n)
    })
  })

  describe('lead conversion', () => {
    it('creates a company, a contact and a deal, and keeps the lead', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await service.ensureDefaultPipeline(ctx)

      const lead = await service.createLead(
        ctx,
        { name: 'Grace Hopper', email: 'grace@example.test', companyName: 'Navy Systems' },
        meta,
      )

      const result = await service.convertLead(
        ctx,
        { leadId: lead.id, createDeal: true, dealTitle: 'Navy deal', dealValueMinor: 5_000_00n },
        meta,
      )

      expect(result.companyId).toBeTruthy()
      expect(result.contactId).toBeTruthy()
      expect(result.dealId).toBeTruthy()

      // Non-destructive: the lead survives, linked to what it became.
      const converted = await service.getLead(ctx, lead.id)
      expect(converted.status).toBe('CONVERTED')
      expect(converted.convertedCompanyId).toBe(result.companyId)
      expect(converted.convertedDealId).toBe(result.dealId)

      const company = await service.getCompany(ctx, result.companyId)
      expect(company.name).toBe('Navy Systems')
      expect(company.contacts).toHaveLength(1)
    })

    it('refuses to convert the same lead twice', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const lead = await service.createLead(ctx, { name: 'Double Convert' }, meta)

      await service.convertLead(ctx, { leadId: lead.id, createDeal: false }, meta)
      await expect(
        service.convertLead(ctx, { leadId: lead.id, createDeal: false }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'CONFLICT')
    })

    it('refuses an Employee converting a lead', async () => {
      const owner = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const lead = await service.createLead(owner, { name: 'Employee target' }, meta)

      const ctx = await makeCtx('employee', state.orgA, SLUG_A)
      await expect(
        service.convertLead(ctx, { leadId: lead.id, createDeal: false }, meta),
      ).rejects.toSatisfy((error) => isAppError(error) && error.code === 'FORBIDDEN')
    })
  })

  describe('search and pagination', () => {
    it('filters by search term in SQL', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      await service.createCompany(ctx, { name: `Findable ${suffix}` }, meta)

      const params = parseListParams(
        { q: `Findable ${suffix}` },
        { sortableFields: COMPANY_SORT_FIELDS, defaultSort: 'name' },
      )
      const page = await service.listCompanies(ctx, params)

      expect(page.items.length).toBe(1)
      expect(page.items[0]?.name).toBe(`Findable ${suffix}`)
    })

    it('reports a total independent of the page size', async () => {
      const ctx = await makeCtx('ownerA', state.orgA, SLUG_A, true)
      const params = parseListParams(
        { pageSize: '1' },
        { sortableFields: COMPANY_SORT_FIELDS, defaultSort: 'name' },
      )
      const page = await service.listCompanies(ctx, params)

      expect(page.items.length).toBeLessThanOrEqual(1)
      expect(page.total).toBeGreaterThan(1)
    })
  })
})
