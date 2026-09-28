import type { ListParams } from '@/kernel/validation/list-params'
import { containsInsensitive } from '@/kernel/validation/list-params'
import type { Ctx } from '@/kernel/tenancy/ctx'

import type {
  COMPANY_SORT_FIELDS,
  CONTACT_SORT_FIELDS,
  DEAL_SORT_FIELDS,
  LEAD_SORT_FIELDS,
} from './schema'

/**
 * CRM data access.
 *
 * Every query runs through `ctx.db`, the org-scoped client, so a missing
 * organization predicate is not a leak. Filtering, sorting and pagination happen
 * in SQL — never by fetching rows and slicing in JavaScript
 * (docs/OPERATIONS.md §M.3).
 *
 * Soft-deleted rows are excluded here rather than in the service, so no caller
 * can forget.
 */

const live = { deletedAt: null }

/* -------------------------------- companies ------------------------------- */

type CompanySort = (typeof COMPANY_SORT_FIELDS)[number]

export async function listCompanies(ctx: Ctx, params: ListParams<CompanySort>) {
  const where = {
    ...live,
    ...(params.q
      ? {
          OR: [
            { name: containsInsensitive(params.q) },
            { domain: containsInsensitive(params.q) },
            { industry: containsInsensitive(params.q) },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.company.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        name: true,
        domain: true,
        industry: true,
        createdAt: true,
        owner: { select: { id: true, user: { select: { name: true } } } },
        _count: { select: { contacts: true, deals: true } },
      },
    }),
    ctx.db.company.count({ where }),
  ])

  return { items, total }
}

export async function findCompany(ctx: Ctx, id: string) {
  return ctx.db.company.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      name: true,
      domain: true,
      industry: true,
      size: true,
      website: true,
      phone: true,
      notes: true,
      createdAt: true,
      ownerMembershipId: true,
      owner: { select: { id: true, user: { select: { name: true } } } },
      contacts: {
        where: live,
        orderBy: { lastName: 'asc' },
        select: { id: true, firstName: true, lastName: true, email: true, position: true },
      },
      deals: {
        where: live,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          valueMinor: true,
          currency: true,
          status: true,
          stage: { select: { name: true } },
        },
      },
    },
  })
}

export async function createCompany(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.company.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, name: true },
  })
}

export async function updateCompany(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.company.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteCompany(ctx: Ctx, id: string) {
  const result = await ctx.db.company.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

/** Companies for a picker. Capped: a picker is not a list screen. */
export async function companyOptions(ctx: Ctx, limit = 100) {
  return ctx.db.company.findMany({
    where: live,
    orderBy: { name: 'asc' },
    take: limit,
    select: { id: true, name: true },
  })
}

/* -------------------------------- contacts -------------------------------- */

type ContactSort = (typeof CONTACT_SORT_FIELDS)[number]

export async function listContacts(ctx: Ctx, params: ListParams<ContactSort>, companyId?: string) {
  const where = {
    ...live,
    ...(companyId ? { companyId } : {}),
    ...(params.q
      ? {
          OR: [
            { firstName: containsInsensitive(params.q) },
            { lastName: containsInsensitive(params.q) },
            { email: containsInsensitive(params.q) },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.contact.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        position: true,
        createdAt: true,
        company: { select: { id: true, name: true } },
        owner: { select: { id: true, user: { select: { name: true } } } },
      },
    }),
    ctx.db.contact.count({ where }),
  ])

  return { items, total }
}

export async function findContact(ctx: Ctx, id: string) {
  return ctx.db.contact.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      position: true,
      notes: true,
      createdAt: true,
      companyId: true,
      ownerMembershipId: true,
      company: { select: { id: true, name: true } },
      owner: { select: { id: true, user: { select: { name: true } } } },
      deals: {
        where: live,
        select: { id: true, title: true, valueMinor: true, currency: true, status: true },
      },
    },
  })
}

export async function createContact(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.contact.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, firstName: true, lastName: true },
  })
}

export async function updateContact(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.contact.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteContact(ctx: Ctx, id: string) {
  const result = await ctx.db.contact.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

export async function contactOptions(ctx: Ctx, companyId?: string, limit = 100) {
  return ctx.db.contact.findMany({
    where: { ...live, ...(companyId ? { companyId } : {}) },
    orderBy: { lastName: 'asc' },
    take: limit,
    select: { id: true, firstName: true, lastName: true },
  })
}

/* ---------------------------------- leads --------------------------------- */

type LeadSort = (typeof LEAD_SORT_FIELDS)[number]

export async function listLeads(
  ctx: Ctx,
  params: ListParams<LeadSort>,
  filters: { status?: string | undefined; ownerMembershipId?: string | undefined } = {},
) {
  const where = {
    ...live,
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.ownerMembershipId ? { ownerMembershipId: filters.ownerMembershipId } : {}),
    ...(params.q
      ? {
          OR: [
            { name: containsInsensitive(params.q) },
            { email: containsInsensitive(params.q) },
            { companyName: containsInsensitive(params.q) },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.lead.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        name: true,
        email: true,
        companyName: true,
        source: true,
        status: true,
        score: true,
        createdAt: true,
        convertedAt: true,
        owner: { select: { id: true, user: { select: { name: true } } } },
      },
    }),
    ctx.db.lead.count({ where }),
  ])

  return { items, total }
}

export async function findLead(ctx: Ctx, id: string) {
  return ctx.db.lead.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      companyName: true,
      source: true,
      status: true,
      score: true,
      notes: true,
      createdAt: true,
      convertedAt: true,
      convertedContactId: true,
      convertedCompanyId: true,
      convertedDealId: true,
      ownerMembershipId: true,
      owner: { select: { id: true, user: { select: { name: true } } } },
    },
  })
}

export async function createLead(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.lead.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, name: true },
  })
}

export async function updateLead(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.lead.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteLead(ctx: Ctx, id: string) {
  const result = await ctx.db.lead.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

export async function countLeadsByStatus(ctx: Ctx) {
  return ctx.db.lead.groupBy({ by: ['status'], where: live, _count: { _all: true } })
}

/* -------------------------------- pipelines ------------------------------- */

export async function listPipelines(ctx: Ctx) {
  return ctx.db.pipeline.findMany({
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      isDefault: true,
      stages: {
        orderBy: { position: 'asc' },
        select: { id: true, name: true, position: true, probability: true, type: true },
      },
    },
  })
}

export async function findDefaultPipeline(ctx: Ctx) {
  return ctx.db.pipeline.findFirst({
    where: { isDefault: true },
    select: {
      id: true,
      name: true,
      stages: { orderBy: { position: 'asc' }, select: { id: true, name: true, type: true } },
    },
  })
}

export async function findStage(ctx: Ctx, stageId: string) {
  return ctx.db.pipelineStage.findFirst({
    where: { id: stageId },
    select: { id: true, name: true, type: true, pipelineId: true, probability: true },
  })
}

export async function createPipelineWithStages(
  ctx: Ctx,
  input: {
    name: string
    isDefault: boolean
    stages: Array<{ name: string; probability: number; type: 'OPEN' | 'WON' | 'LOST' }>
  },
) {
  const pipeline = await ctx.db.pipeline.create({
    data: { organizationId: ctx.orgId, name: input.name, isDefault: input.isDefault },
    select: { id: true },
  })

  await ctx.db.pipelineStage.createMany({
    data: input.stages.map((stage, index) => ({
      organizationId: ctx.orgId,
      pipelineId: pipeline.id,
      name: stage.name,
      position: index,
      probability: stage.probability,
      type: stage.type,
    })),
  })

  return pipeline
}

export async function countPipelines(ctx: Ctx): Promise<number> {
  return ctx.db.pipeline.count()
}

/* ---------------------------------- deals --------------------------------- */

type DealSort = (typeof DEAL_SORT_FIELDS)[number]

export async function listDeals(
  ctx: Ctx,
  params: ListParams<DealSort>,
  filters: {
    status?: string | undefined
    pipelineId?: string | undefined
    companyId?: string | undefined
  } = {},
) {
  const where = {
    ...live,
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.pipelineId ? { pipelineId: filters.pipelineId } : {}),
    ...(filters.companyId ? { companyId: filters.companyId } : {}),
    ...(params.q ? { title: containsInsensitive(params.q) } : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.deal.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        title: true,
        valueMinor: true,
        currency: true,
        status: true,
        expectedCloseDate: true,
        createdAt: true,
        stage: { select: { id: true, name: true, type: true } },
        company: { select: { id: true, name: true } },
        owner: { select: { id: true, user: { select: { name: true } } } },
      },
    }),
    ctx.db.deal.count({ where }),
  ])

  return { items, total }
}

/** Deals grouped for the pipeline board. Capped per stage to bound the payload. */
export async function listDealsForBoard(ctx: Ctx, pipelineId: string, perStage = 50) {
  return ctx.db.deal.findMany({
    where: { ...live, pipelineId, status: 'OPEN' },
    orderBy: { updatedAt: 'desc' },
    take: perStage * 12,
    select: {
      id: true,
      title: true,
      valueMinor: true,
      currency: true,
      stageId: true,
      expectedCloseDate: true,
      company: { select: { id: true, name: true } },
      owner: { select: { user: { select: { name: true } } } },
    },
  })
}

export async function findDeal(ctx: Ctx, id: string) {
  return ctx.db.deal.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      title: true,
      valueMinor: true,
      currency: true,
      status: true,
      expectedCloseDate: true,
      wonAt: true,
      lostAt: true,
      lostReason: true,
      createdAt: true,
      pipelineId: true,
      stageId: true,
      companyId: true,
      primaryContactId: true,
      ownerMembershipId: true,
      convertedProjectId: true,
      pipeline: { select: { id: true, name: true } },
      stage: { select: { id: true, name: true, type: true, probability: true } },
      company: { select: { id: true, name: true } },
      primaryContact: { select: { id: true, firstName: true, lastName: true, email: true } },
      owner: { select: { id: true, user: { select: { name: true } } } },
    },
  })
}

export async function createDeal(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.deal.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, title: true, stageId: true },
  })
}

export async function updateDeal(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.deal.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteDeal(ctx: Ctx, id: string) {
  const result = await ctx.db.deal.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

export async function recordStageChange(
  ctx: Ctx,
  input: {
    dealId: string
    fromStageId: string | null
    toStageId: string
    durationSeconds: number | null
  },
) {
  await ctx.db.dealStageHistory.create({
    data: {
      organizationId: ctx.orgId,
      dealId: input.dealId,
      fromStageId: input.fromStageId,
      toStageId: input.toStageId,
      changedById: ctx.userId,
      durationSeconds: input.durationSeconds,
    },
  })
}

export async function lastStageChange(ctx: Ctx, dealId: string) {
  return ctx.db.dealStageHistory.findFirst({
    where: { dealId },
    orderBy: { changedAt: 'desc' },
    select: { changedAt: true },
  })
}

export async function listStageHistory(ctx: Ctx, dealId: string) {
  return ctx.db.dealStageHistory.findMany({
    where: { dealId },
    orderBy: { changedAt: 'desc' },
    select: {
      id: true,
      changedAt: true,
      durationSeconds: true,
      fromStage: { select: { name: true } },
      toStage: { select: { name: true } },
    },
  })
}

/** Open pipeline value, grouped by stage, for the dashboard and analytics. */
export async function sumOpenPipeline(ctx: Ctx) {
  return ctx.db.deal.groupBy({
    by: ['stageId'],
    where: { ...live, status: 'OPEN' },
    _sum: { valueMinor: true },
    _count: { _all: true },
  })
}

export async function sumDealsByStatus(ctx: Ctx, status: 'OPEN' | 'WON' | 'LOST', since?: Date) {
  const result = await ctx.db.deal.aggregate({
    where: { ...live, status, ...(since ? { updatedAt: { gte: since } } : {}) },
    _sum: { valueMinor: true },
    _count: { _all: true },
  })
  return { total: result._sum.valueMinor ?? 0n, count: result._count._all }
}

/* -------------------------------- activities ------------------------------ */

export async function listActivities(
  ctx: Ctx,
  entity: { entityType: string; entityId: string },
  limit = 50,
) {
  return ctx.db.activity.findMany({
    where: { entityType: entity.entityType, entityId: entity.entityId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      subject: true,
      body: true,
      dueAt: true,
      completedAt: true,
      createdAt: true,
      owner: { select: { user: { select: { name: true } } } },
    },
  })
}

export async function createActivity(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.activity.create({
    data: {
      ...data,
      organizationId: ctx.orgId,
      createdById: ctx.userId,
      ownerMembershipId: ctx.membershipId,
    } as never,
    select: { id: true },
  })
}

export async function completeActivity(ctx: Ctx, id: string) {
  const result = await ctx.db.activity.updateMany({
    where: { id, completedAt: null },
    data: { completedAt: new Date() },
  })
  return result.count
}

export async function listUpcomingActivities(ctx: Ctx, limit = 5) {
  return ctx.db.activity.findMany({
    where: { completedAt: null, dueAt: { not: null } },
    orderBy: { dueAt: 'asc' },
    take: limit,
    select: { id: true, subject: true, type: true, dueAt: true, entityType: true, entityId: true },
  })
}

/* ----------------------------------- tags --------------------------------- */

export async function listTags(ctx: Ctx) {
  return ctx.db.tag.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, color: true },
  })
}

export async function createTag(ctx: Ctx, input: { name: string; color: string }) {
  return ctx.db.tag.create({
    data: { organizationId: ctx.orgId, name: input.name, color: input.color },
    select: { id: true, name: true, color: true },
  })
}

export async function tagsForEntity(ctx: Ctx, entityType: string, entityId: string) {
  const rows = await ctx.db.entityTag.findMany({
    where: { entityType, entityId },
    select: { id: true, tag: { select: { id: true, name: true, color: true } } },
  })
  return rows.map((row) => ({ entityTagId: row.id, ...row.tag }))
}

export async function attachTag(
  ctx: Ctx,
  input: { tagId: string; entityType: string; entityId: string },
) {
  return ctx.db.entityTag.upsert({
    where: {
      tagId_entityType_entityId: {
        tagId: input.tagId,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    },
    create: { organizationId: ctx.orgId, ...input },
    update: {},
    select: { id: true },
  })
}

export async function detachTag(
  ctx: Ctx,
  input: { tagId: string; entityType: string; entityId: string },
) {
  const result = await ctx.db.entityTag.deleteMany({ where: input })
  return result.count
}

/** Verify a tag belongs to this organization before attaching it. */
export async function findTag(ctx: Ctx, tagId: string) {
  return ctx.db.tag.findFirst({ where: { id: tagId }, select: { id: true, name: true } })
}
