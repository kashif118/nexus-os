import { writeAuditLog } from '@/kernel/audit/write'
import { emitEvent } from '@/kernel/events'
import { scheduleDrain } from '@/modules/notifications/dispatch'
import { conflict, forbidden, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { toPageResult, type ListParams } from '@/kernel/validation/list-params'

import { assessHealth } from './health'
import * as repository from './repository'
import type { ProjectSort } from './repository'

/**
 * Project business rules.
 *
 * The visibility model is the interesting part. A project can be open to the
 * whole organization, limited to its members, or private. Two permissions
 * express who may see what — `project.read.any` and `project.read.member` — and
 * the decision is resolved into a QUERY FILTER rather than a post-fetch check,
 * so the database never returns a row the actor should not have
 * (docs/PLATFORM.md §I.4).
 */

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * Resolve how much of the project list this actor may see.
 *
 * Throws rather than returning an empty list when they may see nothing: an empty
 * list implies "there are none", which is a different and misleading statement.
 */
function readScope(ctx: Ctx): 'all' | 'own' {
  const scope = ctx.scope('project.read.any', 'project.read.member')
  if (scope === 'none') throw forbidden('You do not have access to projects.')
  return scope
}

/** Can this actor modify this project? */
async function requireWriteAccess(ctx: Ctx, projectId: string): Promise<void> {
  if (ctx.can('project.update.any')) return

  if (ctx.can('project.update.own')) {
    const project = await repository.findProject(ctx, projectId, 'own')
    // `update.own` means the projects you run, not merely ones you can see.
    if (project?.managerMembershipId === ctx.membershipId) return
  }

  throw forbidden('You do not have permission to change this project.')
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function listProjects(
  ctx: Ctx,
  params: ListParams<ProjectSort>,
  filters: {
    status?: string | undefined
    companyId?: string | undefined
    health?: string | undefined
  } = {},
) {
  const scope = readScope(ctx)
  const { items, total } = await repository.listProjects(ctx, params, { scope, ...filters })
  return toPageResult(items, total, params)
}

export async function getProject(ctx: Ctx, id: string) {
  const scope = readScope(ctx)
  const project = await repository.findProject(ctx, id, scope)
  if (!project) throw notFound('That project is not available.')

  // The health signals are recomputed for display so the explanation is always
  // consistent with the stored score, even if the cached score is a few minutes
  // stale.
  const missedMilestones = await repository.countMissedMilestones(ctx, id)
  const assessment = assessHealth({
    status: project.status,
    dueDate: project.dueDate,
    completedAt: project.completedAt,
    progressPercent: project.progressPercent,
    totalTasks: 0,
    overdueTasks: 0,
    missedMilestones,
    budgetMinor: project.budgetMinor,
    spentMinor: null,
  })

  return { ...project, assessment }
}

export async function listProjectOptions(ctx: Ctx) {
  const scope = readScope(ctx)
  return repository.projectOptions(ctx, scope)
}

export async function getPortfolioSummary(ctx: Ctx) {
  const scope = readScope(ctx)
  const [byStatus, byHealth, deadlines, atRisk] = await Promise.all([
    repository.countProjectsByStatus(ctx, scope),
    repository.countProjectsByHealth(ctx, scope),
    repository.listUpcomingDeadlines(ctx, scope),
    repository.listAtRiskProjects(ctx, scope),
  ])
  return { byStatus, byHealth, deadlines, atRisk }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProjectWriteInput {
  key: string
  name: string
  description?: string | undefined
  companyId?: string | undefined
  managerMembershipId?: string | undefined
  status: string
  priority: string
  visibility: string
  startDate?: Date | undefined
  dueDate?: Date | undefined
  budgetMinor?: bigint | undefined
}

export async function createProject(
  ctx: Ctx,
  input: ProjectWriteInput,
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('project.create')

  const existing = await repository.findByKey(ctx, input.key)
  if (existing) {
    throw conflict('That project key is already in use.', { key: ['Already in use.'] })
  }

  const companyId = await resolveCompanyId(ctx, input.companyId)
  const managerMembershipId = await resolveMembershipId(ctx, input.managerMembershipId)

  if (input.startDate && input.dueDate && input.dueDate < input.startDate) {
    throw validationError('The deadline cannot be before the start date.', {
      dueDate: ['Must be on or after the start date.'],
    })
  }

  const assessment = assessHealth({
    status: input.status,
    dueDate: input.dueDate ?? null,
    completedAt: null,
    progressPercent: 0,
    totalTasks: 0,
    overdueTasks: 0,
    missedMilestones: 0,
    budgetMinor: input.budgetMinor ?? null,
    spentMinor: null,
  })

  const project = await repository.createProject(ctx, {
    key: input.key,
    name: input.name,
    description: input.description,
    companyId,
    managerMembershipId,
    status: input.status,
    priority: input.priority,
    visibility: input.visibility,
    startDate: input.startDate,
    dueDate: input.dueDate,
    budgetMinor: input.budgetMinor,
    currency: ctx.org.currency,
    healthScore: assessment.score,
    healthStatus: assessment.status,
    healthComputedAt: new Date(),
  })

  // The manager is a member by definition; without this they would not appear in
  // the team list or workload views.
  if (managerMembershipId) {
    await repository.addMember(ctx, {
      projectId: project.id,
      membershipId: managerMembershipId,
      role: 'LEAD',
      allocationPercent: 0,
    })
  }

  await writeAuditLog({
    action: 'project.created',
    entityType: 'Project',
    entityId: project.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { key: project.key, name: project.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: project.id }
}

export async function updateProject(
  ctx: Ctx,
  id: string,
  input: ProjectWriteInput,
  meta: RequestMeta,
): Promise<void> {
  await requireWriteAccess(ctx, id)

  const current = await repository.projectExists(ctx, id)
  if (!current) throw notFound('That project is not available.')

  if (input.key !== current.key) {
    const clash = await repository.findByKey(ctx, input.key)
    if (clash && clash.id !== id) {
      throw conflict('That project key is already in use.', { key: ['Already in use.'] })
    }
  }

  const companyId = await resolveCompanyId(ctx, input.companyId)
  const managerMembershipId = await resolveMembershipId(ctx, input.managerMembershipId)

  if (input.startDate && input.dueDate && input.dueDate < input.startDate) {
    throw validationError('The deadline cannot be before the start date.', {
      dueDate: ['Must be on or after the start date.'],
    })
  }

  // Budget is a separate permission: a project lead may run the work without
  // being trusted with the commercials.
  const budgetUpdate = ctx.can('project.budget.manage')
    ? { budgetMinor: input.budgetMinor ?? null }
    : {}

  await repository.updateProject(ctx, id, {
    key: input.key,
    name: input.name,
    description: input.description ?? null,
    companyId: companyId ?? null,
    managerMembershipId: managerMembershipId ?? null,
    status: input.status,
    priority: input.priority,
    visibility: input.visibility,
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    completedAt: input.status === 'COMPLETED' ? new Date() : null,
    ...budgetUpdate,
  })

  await recomputeHealth(ctx, id)

  await writeAuditLog({
    action: 'project.updated',
    entityType: 'Project',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteProject(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('project.delete')

  const deleted = await repository.softDeleteProject(ctx, id)
  if (deleted === 0) throw notFound('That project is not available.')

  await writeAuditLog({
    action: 'project.deleted',
    entityType: 'Project',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Recompute and cache health.
 *
 * Called after anything that could change it. Cached on the row so list screens
 * can sort and filter by health in SQL rather than computing it per row.
 */
export async function recomputeHealth(ctx: Ctx, projectId: string): Promise<void> {
  const project = await repository.findProject(ctx, projectId, 'all')
  if (!project) return

  const missedMilestones = await repository.countMissedMilestones(ctx, projectId)

  const assessment = assessHealth({
    status: project.status,
    dueDate: project.dueDate,
    completedAt: project.completedAt,
    progressPercent: project.progressPercent,
    totalTasks: 0,
    overdueTasks: 0,
    missedMilestones,
    budgetMinor: project.budgetMinor,
    spentMinor: null,
  })

  await repository.updateProject(ctx, projectId, {
    healthScore: assessment.score,
    healthStatus: assessment.status,
    healthComputedAt: new Date(),
  })
}

/* -------------------------------------------------------------------------- */
/* Members                                                                     */
/* -------------------------------------------------------------------------- */

export async function addMember(
  ctx: Ctx,
  input: { projectId: string; membershipId: string; role: string; allocationPercent: number },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('project.member.manage')

  const project = await repository.projectExists(ctx, input.projectId)
  if (!project) throw notFound('That project is not available.')

  const membershipId = await resolveMembershipId(ctx, input.membershipId)
  if (!membershipId) throw validationError('Choose a member to add.')

  await repository.addMember(ctx, { ...input, membershipId })

  if (membershipId !== ctx.membershipId) {
    await emitEvent({
      type: 'project.member.added',
      organizationId: ctx.orgId,
      entityType: 'Project',
      entityId: input.projectId,
      actorId: ctx.userId,
      payload: {
        actorName: ctx.user.name,
        actorMembershipId: ctx.membershipId,
        membershipId,
        name: project.name,
      },
    })
    scheduleDrain()
  }

  await writeAuditLog({
    action: 'project.member_added',
    entityType: 'Project',
    entityId: input.projectId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { membershipId, role: input.role },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function removeMember(
  ctx: Ctx,
  input: { projectId: string; membershipId: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('project.member.manage')

  const removed = await repository.removeMember(ctx, input.projectId, input.membershipId)
  if (removed === 0) throw notFound('That person is not on this project.')

  await writeAuditLog({
    action: 'project.member_removed',
    entityType: 'Project',
    entityId: input.projectId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { membershipId: input.membershipId },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Milestones                                                                  */
/* -------------------------------------------------------------------------- */

export async function createMilestone(
  ctx: Ctx,
  input: {
    projectId: string
    name: string
    description?: string | undefined
    dueDate?: Date | undefined
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('milestone.create')

  const project = await repository.projectExists(ctx, input.projectId)
  if (!project) throw notFound('That project is not available.')

  const position = await repository.nextMilestonePosition(ctx, input.projectId)
  await repository.createMilestone(ctx, { ...input, position })
  await recomputeHealth(ctx, input.projectId)

  await writeAuditLog({
    action: 'project.milestone_created',
    entityType: 'Project',
    entityId: input.projectId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { name: input.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function setMilestoneStatus(
  ctx: Ctx,
  input: { milestoneId: string; status: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('milestone.update')

  const milestone = await repository.findMilestone(ctx, input.milestoneId)
  if (!milestone) throw notFound('That milestone is not available.')

  await repository.updateMilestone(ctx, input.milestoneId, {
    status: input.status,
    completedAt: input.status === 'COMPLETED' ? new Date() : null,
  })

  await recomputeHealth(ctx, milestone.projectId)

  await writeAuditLog({
    action: 'project.milestone_updated',
    entityType: 'Project',
    entityId: milestone.projectId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { milestoneId: input.milestoneId, status: input.status },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteMilestone(
  ctx: Ctx,
  milestoneId: string,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('milestone.delete')

  const milestone = await repository.findMilestone(ctx, milestoneId)
  if (!milestone) throw notFound('That milestone is not available.')

  await repository.deleteMilestone(ctx, milestoneId)
  await recomputeHealth(ctx, milestone.projectId)

  await writeAuditLog({
    action: 'project.milestone_deleted',
    entityType: 'Project',
    entityId: milestone.projectId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Verify a company id belongs to this organization.
 *
 * Read through the org-scoped client, so an id from another tenant simply does
 * not resolve.
 */
async function resolveCompanyId(ctx: Ctx, companyId: string | undefined) {
  if (!companyId) return undefined

  const company = await ctx.db.company.findFirst({
    where: { id: companyId, deletedAt: null },
    select: { id: true },
  })
  if (!company) {
    throw validationError('That client is not available.', { companyId: ['Unknown client.'] })
  }
  return companyId
}

async function resolveMembershipId(ctx: Ctx, membershipId: string | undefined) {
  if (!membershipId) return undefined

  const membership = await ctx.db.membership.findFirst({
    where: { id: membershipId, status: 'ACTIVE' },
    select: { id: true },
  })
  if (!membership) {
    throw validationError('That person is not a member of this organization.', {
      managerMembershipId: ['Unknown member.'],
    })
  }
  return membershipId
}

/** Members available to add to a project, plus the client list. */
export async function getProjectFormOptions(ctx: Ctx) {
  const [members, companies] = await Promise.all([
    ctx.db.membership.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, user: { select: { name: true } } },
    }),
    ctx.can('crm.company.read')
      ? ctx.db.company.findMany({
          where: { deletedAt: null },
          orderBy: { name: 'asc' },
          take: 200,
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ])

  return {
    members: members.map((member) => ({ id: member.id, name: member.user.name })),
    companies,
  }
}
