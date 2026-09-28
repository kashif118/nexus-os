import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'
import { toPageResult } from '@/kernel/validation/list-params'

import * as repository from './repository'
import type {
  COMPANY_SORT_FIELDS,
  CONTACT_SORT_FIELDS,
  DEAL_SORT_FIELDS,
  LEAD_SORT_FIELDS,
} from './schema'

/**
 * CRM business rules.
 *
 * Two patterns run through every function here:
 *
 * - **Permission first, then work.** `ctx.require` runs before any query, so an
 *   unauthorised caller never causes a read.
 * - **Ids from the client are re-resolved, never trusted.** A company id on a
 *   contact form is looked up through `ctx.db` before use, so an id belonging to
 *   another tenant resolves to nothing rather than creating a cross-tenant link
 *   (docs/PLATFORM.md §H.3, layer 3).
 */

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/** Default pipeline created for a new organization. */
const DEFAULT_STAGES = [
  { name: 'Qualified', probability: 10, type: 'OPEN' as const },
  { name: 'Discovery', probability: 25, type: 'OPEN' as const },
  { name: 'Proposal', probability: 50, type: 'OPEN' as const },
  { name: 'Negotiation', probability: 75, type: 'OPEN' as const },
  { name: 'Won', probability: 100, type: 'WON' as const },
  { name: 'Lost', probability: 0, type: 'LOST' as const },
]

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Verify an optional relation id belongs to this organization.
 *
 * Returns undefined for "none selected", and throws if the id does not resolve —
 * which is what happens when it belongs to another tenant, since the lookup is
 * org-scoped.
 */
async function resolveCompanyId(ctx: Ctx, companyId: string | undefined) {
  if (!companyId) return undefined
  const company = await repository.findCompany(ctx, companyId)
  if (!company)
    throw validationError('That company is not available.', { companyId: ['Unknown company.'] })
  return companyId
}

async function resolveContactId(ctx: Ctx, contactId: string | undefined) {
  if (!contactId) return undefined
  const contact = await repository.findContact(ctx, contactId)
  if (!contact) {
    throw validationError('That contact is not available.', {
      primaryContactId: ['Unknown contact.'],
    })
  }
  return contactId
}

/**
 * Verify an owner is an active member of THIS organization.
 *
 * Without this, a crafted form could assign a record to a membership in another
 * tenant, which would leak that membership id back through the UI.
 */
async function resolveOwnerId(ctx: Ctx, membershipId: string | undefined) {
  if (!membershipId) return undefined
  const membership = await ctx.db.membership.findFirst({
    where: { id: membershipId, status: 'ACTIVE' },
    select: { id: true },
  })
  if (!membership) {
    throw validationError('That owner is not a member of this organization.', {
      ownerMembershipId: ['Unknown member.'],
    })
  }
  return membershipId
}

/* -------------------------------------------------------------------------- */
/* Companies                                                                   */
/* -------------------------------------------------------------------------- */

export async function listCompanies(
  ctx: Ctx,
  params: ListParams<(typeof COMPANY_SORT_FIELDS)[number]>,
) {
  ctx.require('crm.company.read')
  const { items, total } = await repository.listCompanies(ctx, params)
  return toPageResult(items, total, params)
}

export async function getCompany(ctx: Ctx, id: string) {
  ctx.require('crm.company.read')
  const company = await repository.findCompany(ctx, id)
  if (!company) throw notFound('That company is not available.')

  const [activities, tags] = await Promise.all([
    repository.listActivities(ctx, { entityType: 'Company', entityId: id }),
    repository.tagsForEntity(ctx, 'Company', id),
  ])

  return { ...company, activities, tags }
}

export async function createCompany(
  ctx: Ctx,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('crm.company.create')

  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId as string | undefined)
  const company = await repository.createCompany(ctx, { ...input, ownerMembershipId })

  await writeAuditLog({
    action: 'crm.company.created',
    entityType: 'Company',
    entityId: company.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { name: company.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: company.id }
}

export async function updateCompany(
  ctx: Ctx,
  id: string,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('crm.company.update')

  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId as string | undefined)
  const updated = await repository.updateCompany(ctx, id, { ...input, ownerMembershipId })
  if (updated === 0) throw notFound('That company is not available.')

  await writeAuditLog({
    action: 'crm.company.updated',
    entityType: 'Company',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteCompany(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('crm.company.delete')

  const deleted = await repository.softDeleteCompany(ctx, id)
  if (deleted === 0) throw notFound('That company is not available.')

  await writeAuditLog({
    action: 'crm.company.deleted',
    entityType: 'Company',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Contacts                                                                    */
/* -------------------------------------------------------------------------- */

export async function listContacts(
  ctx: Ctx,
  params: ListParams<(typeof CONTACT_SORT_FIELDS)[number]>,
  companyId?: string,
) {
  ctx.require('crm.contact.read')
  const { items, total } = await repository.listContacts(ctx, params, companyId)
  return toPageResult(items, total, params)
}

export async function getContact(ctx: Ctx, id: string) {
  ctx.require('crm.contact.read')
  const contact = await repository.findContact(ctx, id)
  if (!contact) throw notFound('That contact is not available.')

  const [activities, tags] = await Promise.all([
    repository.listActivities(ctx, { entityType: 'Contact', entityId: id }),
    repository.tagsForEntity(ctx, 'Contact', id),
  ])

  return { ...contact, activities, tags }
}

export async function createContact(
  ctx: Ctx,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('crm.contact.create')

  const companyId = await resolveCompanyId(ctx, input.companyId as string | undefined)
  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId as string | undefined)

  const contact = await repository.createContact(ctx, { ...input, companyId, ownerMembershipId })

  await writeAuditLog({
    action: 'crm.contact.created',
    entityType: 'Contact',
    entityId: contact.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: contact.id }
}

export async function updateContact(
  ctx: Ctx,
  id: string,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('crm.contact.update')

  const companyId = await resolveCompanyId(ctx, input.companyId as string | undefined)
  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId as string | undefined)

  const updated = await repository.updateContact(ctx, id, {
    ...input,
    companyId,
    ownerMembershipId,
  })
  if (updated === 0) throw notFound('That contact is not available.')

  await writeAuditLog({
    action: 'crm.contact.updated',
    entityType: 'Contact',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteContact(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('crm.contact.delete')

  const deleted = await repository.softDeleteContact(ctx, id)
  if (deleted === 0) throw notFound('That contact is not available.')

  await writeAuditLog({
    action: 'crm.contact.deleted',
    entityType: 'Contact',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Leads                                                                       */
/* -------------------------------------------------------------------------- */

export async function listLeads(
  ctx: Ctx,
  params: ListParams<(typeof LEAD_SORT_FIELDS)[number]>,
  filters: { status?: string | undefined } = {},
) {
  ctx.require('crm.lead.read')
  const { items, total } = await repository.listLeads(ctx, params, filters)
  return toPageResult(items, total, params)
}

export async function getLead(ctx: Ctx, id: string) {
  ctx.require('crm.lead.read')
  const lead = await repository.findLead(ctx, id)
  if (!lead) throw notFound('That lead is not available.')

  const [activities, tags] = await Promise.all([
    repository.listActivities(ctx, { entityType: 'Lead', entityId: id }),
    repository.tagsForEntity(ctx, 'Lead', id),
  ])

  return { ...lead, activities, tags }
}

export async function createLead(
  ctx: Ctx,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('crm.lead.create')

  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId as string | undefined)
  const lead = await repository.createLead(ctx, { ...input, ownerMembershipId })

  await writeAuditLog({
    action: 'crm.lead.created',
    entityType: 'Lead',
    entityId: lead.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: lead.id }
}

export async function updateLead(
  ctx: Ctx,
  id: string,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('crm.lead.update')

  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId as string | undefined)
  const updated = await repository.updateLead(ctx, id, { ...input, ownerMembershipId })
  if (updated === 0) throw notFound('That lead is not available.')

  await writeAuditLog({
    action: 'crm.lead.updated',
    entityType: 'Lead',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteLead(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('crm.lead.delete')

  const deleted = await repository.softDeleteLead(ctx, id)
  if (deleted === 0) throw notFound('That lead is not available.')

  await writeAuditLog({
    action: 'crm.lead.deleted',
    entityType: 'Lead',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Convert a lead into a company, a contact and optionally a deal.
 *
 * Non-destructive by design (docs/DATA-MODEL.md §E.1.4): the lead survives with
 * pointers to what it became, so the funnel can still attribute the eventual
 * revenue to its original source.
 */
export async function convertLead(
  ctx: Ctx,
  input: { leadId: string; createDeal: boolean; dealTitle?: string; dealValueMinor?: bigint },
  meta: RequestMeta,
): Promise<{ companyId: string; contactId: string; dealId: string | null }> {
  ctx.require('crm.lead.convert')
  ctx.require('crm.contact.create')

  const lead = await repository.findLead(ctx, input.leadId)
  if (!lead) throw notFound('That lead is not available.')
  if (lead.convertedAt) throw conflict('That lead has already been converted.')

  const company = await repository.createCompany(ctx, {
    name: lead.companyName?.trim() || lead.name,
    ownerMembershipId: lead.ownerMembershipId ?? undefined,
  })

  // Leads carry a single free-text name; split it conservatively rather than
  // guessing at multi-part surnames.
  const [firstName = lead.name, ...rest] = lead.name.trim().split(/\s+/)
  const contact = await repository.createContact(ctx, {
    firstName,
    lastName: rest.join(' ') || firstName,
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    companyId: company.id,
    ownerMembershipId: lead.ownerMembershipId ?? undefined,
  })

  let dealId: string | null = null

  if (input.createDeal) {
    ctx.require('crm.deal.create')

    const pipeline = await repository.findDefaultPipeline(ctx)
    if (!pipeline) {
      throw validationError(
        'No default pipeline exists yet. Create one before converting leads into deals.',
      )
    }

    const firstStage = pipeline.stages.find((stage) => stage.type === 'OPEN') ?? pipeline.stages[0]
    if (!firstStage) throw validationError('That pipeline has no stages.')

    const deal = await repository.createDeal(ctx, {
      title: input.dealTitle?.trim() || `${company.name} opportunity`,
      pipelineId: pipeline.id,
      stageId: firstStage.id,
      companyId: company.id,
      primaryContactId: contact.id,
      valueMinor: input.dealValueMinor ?? 0n,
      currency: ctx.org.currency,
      ownerMembershipId: lead.ownerMembershipId ?? undefined,
    })
    dealId = deal.id

    await repository.recordStageChange(ctx, {
      dealId: deal.id,
      fromStageId: null,
      toStageId: firstStage.id,
      durationSeconds: null,
    })
  }

  await repository.updateLead(ctx, lead.id, {
    status: 'CONVERTED',
    convertedAt: new Date(),
    convertedCompanyId: company.id,
    convertedContactId: contact.id,
    convertedDealId: dealId,
  })

  await writeAuditLog({
    action: 'crm.lead.converted',
    entityType: 'Lead',
    entityId: lead.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { companyId: company.id, contactId: contact.id, dealId },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { companyId: company.id, contactId: contact.id, dealId }
}

/* -------------------------------------------------------------------------- */
/* Pipelines and deals                                                         */
/* -------------------------------------------------------------------------- */

export async function listPipelines(ctx: Ctx) {
  ctx.require('crm.deal.read')
  return repository.listPipelines(ctx)
}

/**
 * Create the default pipeline the first time the CRM is opened.
 *
 * An organization with no pipeline cannot hold a deal, so this runs lazily
 * rather than requiring a setup step. Idempotent.
 */
export async function ensureDefaultPipeline(ctx: Ctx) {
  const existing = await repository.countPipelines(ctx)
  if (existing > 0) return repository.findDefaultPipeline(ctx)

  ctx.require('crm.deal.create')
  await repository.createPipelineWithStages(ctx, {
    name: 'Sales pipeline',
    isDefault: true,
    stages: DEFAULT_STAGES,
  })

  return repository.findDefaultPipeline(ctx)
}

export async function listDeals(
  ctx: Ctx,
  params: ListParams<(typeof DEAL_SORT_FIELDS)[number]>,
  filters: { status?: string | undefined; pipelineId?: string | undefined } = {},
) {
  ctx.require('crm.deal.read')
  const { items, total } = await repository.listDeals(ctx, params, filters)
  return toPageResult(items, total, params)
}

export async function getPipelineBoard(ctx: Ctx, pipelineId?: string) {
  ctx.require('crm.deal.read')

  const pipelines = await repository.listPipelines(ctx)
  const pipeline = pipelineId
    ? pipelines.find((entry) => entry.id === pipelineId)
    : (pipelines.find((entry) => entry.isDefault) ?? pipelines[0])

  if (!pipeline) return { pipelines, pipeline: null, deals: [] }

  const deals = await repository.listDealsForBoard(ctx, pipeline.id)
  return { pipelines, pipeline, deals }
}

export async function getDeal(ctx: Ctx, id: string) {
  ctx.require('crm.deal.read')
  const deal = await repository.findDeal(ctx, id)
  if (!deal) throw notFound('That deal is not available.')

  const [activities, tags, history] = await Promise.all([
    repository.listActivities(ctx, { entityType: 'Deal', entityId: id }),
    repository.tagsForEntity(ctx, 'Deal', id),
    repository.listStageHistory(ctx, id),
  ])

  return { ...deal, activities, tags, history }
}

export async function createDeal(
  ctx: Ctx,
  input: {
    title: string
    pipelineId: string
    stageId: string
    companyId?: string | undefined
    primaryContactId?: string | undefined
    valueMinor: bigint
    expectedCloseDate?: Date | undefined
    ownerMembershipId?: string | undefined
  },
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('crm.deal.create')

  // The stage is re-resolved to confirm it exists in this organization AND
  // belongs to the pipeline the form claims.
  const stage = await repository.findStage(ctx, input.stageId)
  if (!stage || stage.pipelineId !== input.pipelineId) {
    throw validationError('That stage is not part of the selected pipeline.', {
      stageId: ['Choose a stage from this pipeline.'],
    })
  }

  const companyId = await resolveCompanyId(ctx, input.companyId)
  const primaryContactId = await resolveContactId(ctx, input.primaryContactId)
  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId)

  const deal = await repository.createDeal(ctx, {
    title: input.title,
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    companyId,
    primaryContactId,
    valueMinor: input.valueMinor,
    // Always the organization currency: a per-deal currency needs an FX policy,
    // which belongs with the finance module.
    currency: ctx.org.currency,
    expectedCloseDate: input.expectedCloseDate,
    ownerMembershipId,
    status: stage.type === 'WON' ? 'WON' : stage.type === 'LOST' ? 'LOST' : 'OPEN',
  })

  await repository.recordStageChange(ctx, {
    dealId: deal.id,
    fromStageId: null,
    toStageId: input.stageId,
    durationSeconds: null,
  })

  await writeAuditLog({
    action: 'crm.deal.created',
    entityType: 'Deal',
    entityId: deal.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { title: deal.title },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: deal.id }
}

/**
 * Move a deal to another stage.
 *
 * Records the move and how long the deal sat in the previous stage, which is
 * what makes stage velocity computable without scanning history at read time.
 */
export async function moveDeal(
  ctx: Ctx,
  input: { dealId: string; stageId: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('crm.deal.stage.move')

  const deal = await repository.findDeal(ctx, input.dealId)
  if (!deal) throw notFound('That deal is not available.')

  const stage = await repository.findStage(ctx, input.stageId)
  if (!stage) throw notFound('That stage is not available.')
  if (stage.pipelineId !== deal.pipelineId) {
    throw validationError('That stage belongs to a different pipeline.')
  }
  if (stage.id === deal.stageId) return

  const previous = await repository.lastStageChange(ctx, deal.id)
  const since = previous?.changedAt ?? deal.createdAt
  const durationSeconds = Math.max(0, Math.round((Date.now() - since.getTime()) / 1000))

  const status = stage.type === 'WON' ? 'WON' : stage.type === 'LOST' ? 'LOST' : 'OPEN'

  await repository.updateDeal(ctx, deal.id, {
    stageId: stage.id,
    status,
    wonAt: status === 'WON' ? new Date() : null,
    lostAt: status === 'LOST' ? new Date() : null,
  })

  await repository.recordStageChange(ctx, {
    dealId: deal.id,
    fromStageId: deal.stageId,
    toStageId: stage.id,
    durationSeconds,
  })

  await writeAuditLog({
    action: 'crm.deal.stage_changed',
    entityType: 'Deal',
    entityId: deal.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { from: deal.stage.name, to: stage.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function updateDeal(
  ctx: Ctx,
  id: string,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('crm.deal.update')

  const companyId = await resolveCompanyId(ctx, input.companyId as string | undefined)
  const primaryContactId = await resolveContactId(ctx, input.primaryContactId as string | undefined)
  const ownerMembershipId = await resolveOwnerId(ctx, input.ownerMembershipId as string | undefined)

  const { pipelineId: _pipelineId, stageId: _stageId, ...rest } = input

  const updated = await repository.updateDeal(ctx, id, {
    ...rest,
    companyId,
    primaryContactId,
    ownerMembershipId,
  })
  if (updated === 0) throw notFound('That deal is not available.')

  await writeAuditLog({
    action: 'crm.deal.updated',
    entityType: 'Deal',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteDeal(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('crm.deal.delete')

  const deleted = await repository.softDeleteDeal(ctx, id)
  if (deleted === 0) throw notFound('That deal is not available.')

  await writeAuditLog({
    action: 'crm.deal.deleted',
    entityType: 'Deal',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Activities and tags                                                         */
/* -------------------------------------------------------------------------- */

const ENTITY_READ_PERMISSION = {
  Company: 'crm.company.read',
  Contact: 'crm.contact.read',
  Lead: 'crm.lead.read',
  Deal: 'crm.deal.read',
} as const

export async function logActivity(
  ctx: Ctx,
  input: {
    type: string
    subject: string
    body?: string | undefined
    dueAt?: Date | undefined
    entityType: keyof typeof ENTITY_READ_PERMISSION
    entityId: string
  },
  meta: RequestMeta,
): Promise<{ id: string }> {
  // An activity is only as private as the record it hangs off, so the check is
  // the parent record read permission.
  ctx.require(ENTITY_READ_PERMISSION[input.entityType])

  await assertEntityExists(ctx, input.entityType, input.entityId)

  const activity = await repository.createActivity(ctx, {
    type: input.type,
    subject: input.subject,
    body: input.body,
    dueAt: input.dueAt,
    entityType: input.entityType,
    entityId: input.entityId,
  })

  await writeAuditLog({
    action: 'crm.activity.logged',
    entityType: input.entityType,
    entityId: input.entityId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { activityId: activity.id, type: input.type },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return activity
}

export async function completeActivity(ctx: Ctx, id: string): Promise<void> {
  const completed = await repository.completeActivity(ctx, id)
  if (completed === 0) throw notFound('That activity is no longer open.')
}

/**
 * Confirm the parent record exists in this organization.
 *
 * Without it an activity could be attached to a polymorphic id from another
 * tenant, and would then surface on that tenant timeline.
 */
async function assertEntityExists(
  ctx: Ctx,
  entityType: keyof typeof ENTITY_READ_PERMISSION,
  entityId: string,
): Promise<void> {
  const exists =
    entityType === 'Company'
      ? await repository.findCompany(ctx, entityId)
      : entityType === 'Contact'
        ? await repository.findContact(ctx, entityId)
        : entityType === 'Lead'
          ? await repository.findLead(ctx, entityId)
          : await repository.findDeal(ctx, entityId)

  if (!exists) throw notFound('That record is not available.')
}

export async function listTags(ctx: Ctx) {
  return repository.listTags(ctx)
}

export async function createTag(ctx: Ctx, input: { name: string; color: string }) {
  ctx.require('crm.company.update')
  try {
    return await repository.createTag(ctx, input)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('A tag with that name already exists.', { name: ['Already in use.'] })
    }
    throw error
  }
}

export async function attachTag(
  ctx: Ctx,
  input: { tagId: string; entityType: keyof typeof ENTITY_READ_PERMISSION; entityId: string },
): Promise<void> {
  ctx.require(ENTITY_READ_PERMISSION[input.entityType])

  const tag = await repository.findTag(ctx, input.tagId)
  if (!tag) throw notFound('That tag is not available.')

  await assertEntityExists(ctx, input.entityType, input.entityId)
  await repository.attachTag(ctx, input)
}

export async function detachTag(
  ctx: Ctx,
  input: { tagId: string; entityType: keyof typeof ENTITY_READ_PERMISSION; entityId: string },
): Promise<void> {
  ctx.require(ENTITY_READ_PERMISSION[input.entityType])
  await repository.detachTag(ctx, input)
}

/* -------------------------------------------------------------------------- */

export async function getPickerOptions(ctx: Ctx) {
  const [companies, contacts, members] = await Promise.all([
    ctx.can('crm.company.read') ? repository.companyOptions(ctx) : Promise.resolve([]),
    ctx.can('crm.contact.read') ? repository.contactOptions(ctx) : Promise.resolve([]),
    ctx.db.membership.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    }),
  ])

  return {
    companies,
    contacts,
    members: members.map((member) => ({ id: member.id, name: member.user.name })),
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
