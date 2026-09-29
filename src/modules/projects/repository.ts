import type { Ctx } from '@/kernel/tenancy/ctx'
import { containsInsensitive, type ListParams } from '@/kernel/validation/list-params'

/**
 * Project data access.
 *
 * `visibilityFilter` is the important part: project visibility is enforced in
 * the WHERE clause, not by fetching everything and filtering in JavaScript
 * (docs/PLATFORM.md §I.4). A member who may only see projects they belong to
 * gets a query that joins their membership, so the database never returns a row
 * they should not have.
 */

const live = { deletedAt: null }

import type { ProjectSort } from './schema'

export type { ProjectSort }

/**
 * Restrict a project query to what this actor may see.
 *
 * `scope` is resolved from `project.read.any` / `project.read.member` by the
 * service; 'own' means "projects I am a member of, manage, or that are open to
 * the whole organization".
 */
export function visibilityFilter(ctx: Ctx, scope: 'all' | 'own') {
  if (scope === 'all') return {}

  return {
    OR: [
      { visibility: 'ORGANIZATION' as const },
      { managerMembershipId: ctx.membershipId },
      { members: { some: { membershipId: ctx.membershipId } } },
    ],
  }
}

export async function listProjects(
  ctx: Ctx,
  params: ListParams<ProjectSort>,
  options: {
    scope: 'all' | 'own'
    status?: string | undefined
    companyId?: string | undefined
    health?: string | undefined
  },
) {
  const where = {
    ...live,
    ...visibilityFilter(ctx, options.scope),
    ...(options.status ? { status: options.status as never } : {}),
    ...(options.companyId ? { companyId: options.companyId } : {}),
    ...(options.health ? { healthStatus: options.health as never } : {}),
    ...(params.q
      ? {
          OR: [
            { name: containsInsensitive(params.q) },
            { key: containsInsensitive(params.q) },
            { description: containsInsensitive(params.q) },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.project.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        key: true,
        name: true,
        status: true,
        priority: true,
        dueDate: true,
        progressPercent: true,
        healthScore: true,
        healthStatus: true,
        budgetMinor: true,
        currency: true,
        company: { select: { id: true, name: true } },
        manager: { select: { id: true, user: { select: { name: true } } } },
        _count: { select: { members: true, milestones: true } },
      },
    }),
    ctx.db.project.count({ where }),
  ])

  return { items, total }
}

export async function findProject(ctx: Ctx, id: string, scope: 'all' | 'own') {
  return ctx.db.project.findFirst({
    where: { id, ...live, ...visibilityFilter(ctx, scope) },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      status: true,
      priority: true,
      visibility: true,
      startDate: true,
      dueDate: true,
      completedAt: true,
      budgetMinor: true,
      currency: true,
      progressPercent: true,
      healthScore: true,
      healthStatus: true,
      healthComputedAt: true,
      createdAt: true,
      companyId: true,
      managerMembershipId: true,
      company: { select: { id: true, name: true } },
      manager: { select: { id: true, user: { select: { name: true } } } },
      members: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          allocationPercent: true,
          membershipId: true,
          membership: {
            select: {
              id: true,
              title: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      },
      milestones: {
        orderBy: [{ position: 'asc' }, { dueDate: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          dueDate: true,
          status: true,
          completedAt: true,
          position: true,
        },
      },
    },
  })
}

/** Existence check that ignores visibility, for uniqueness and link validation. */
export async function projectExists(ctx: Ctx, id: string) {
  return ctx.db.project.findFirst({
    where: { id, ...live },
    select: { id: true, key: true, name: true },
  })
}

export async function findByKey(ctx: Ctx, key: string) {
  return ctx.db.project.findFirst({ where: { key }, select: { id: true } })
}

export async function createProject(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.project.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, key: true, name: true },
  })
}

export async function updateProject(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.project.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteProject(ctx: Ctx, id: string) {
  const result = await ctx.db.project.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

export async function projectOptions(ctx: Ctx, scope: 'all' | 'own', limit = 200) {
  return ctx.db.project.findMany({
    where: { ...live, ...visibilityFilter(ctx, scope), status: { notIn: ['ARCHIVED'] } },
    orderBy: { name: 'asc' },
    take: limit,
    select: { id: true, key: true, name: true },
  })
}

/* --------------------------------- members -------------------------------- */

export async function addMember(
  ctx: Ctx,
  input: { projectId: string; membershipId: string; role: string; allocationPercent: number },
) {
  return ctx.db.projectMember.upsert({
    where: {
      projectId_membershipId: { projectId: input.projectId, membershipId: input.membershipId },
    },
    create: {
      organizationId: ctx.orgId,
      projectId: input.projectId,
      membershipId: input.membershipId,
      role: input.role as never,
      allocationPercent: input.allocationPercent,
    },
    update: { role: input.role as never, allocationPercent: input.allocationPercent },
    select: { id: true },
  })
}

export async function removeMember(ctx: Ctx, projectId: string, membershipId: string) {
  const result = await ctx.db.projectMember.deleteMany({ where: { projectId, membershipId } })
  return result.count
}

export async function isMember(ctx: Ctx, projectId: string, membershipId: string) {
  const row = await ctx.db.projectMember.findFirst({
    where: { projectId, membershipId },
    select: { id: true },
  })
  return row !== null
}

/* ------------------------------- milestones ------------------------------- */

export async function createMilestone(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.milestone.create({
    data: { ...data, organizationId: ctx.orgId } as never,
    select: { id: true, name: true },
  })
}

export async function updateMilestone(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.milestone.updateMany({ where: { id }, data: data as never })
  return result.count
}

export async function deleteMilestone(ctx: Ctx, id: string) {
  const result = await ctx.db.milestone.deleteMany({ where: { id } })
  return result.count
}

export async function findMilestone(ctx: Ctx, id: string) {
  return ctx.db.milestone.findFirst({
    where: { id },
    select: { id: true, projectId: true, status: true, dueDate: true },
  })
}

export async function countMissedMilestones(ctx: Ctx, projectId: string): Promise<number> {
  return ctx.db.milestone.count({
    where: {
      projectId,
      status: { notIn: ['COMPLETED'] },
      dueDate: { lt: new Date() },
    },
  })
}

export async function nextMilestonePosition(ctx: Ctx, projectId: string): Promise<number> {
  const last = await ctx.db.milestone.findFirst({
    where: { projectId },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  return (last?.position ?? -1) + 1
}

/* ------------------------------- aggregates ------------------------------- */

export async function countProjectsByStatus(ctx: Ctx, scope: 'all' | 'own') {
  return ctx.db.project.groupBy({
    by: ['status'],
    where: { ...live, ...visibilityFilter(ctx, scope) },
    _count: { _all: true },
  })
}

export async function countProjectsByHealth(ctx: Ctx, scope: 'all' | 'own') {
  return ctx.db.project.groupBy({
    by: ['healthStatus'],
    where: {
      ...live,
      ...visibilityFilter(ctx, scope),
      status: { notIn: ['COMPLETED', 'ARCHIVED'] },
    },
    _count: { _all: true },
  })
}

export async function listUpcomingDeadlines(ctx: Ctx, scope: 'all' | 'own', limit = 5) {
  return ctx.db.project.findMany({
    where: {
      ...live,
      ...visibilityFilter(ctx, scope),
      status: { notIn: ['COMPLETED', 'ARCHIVED'] },
      dueDate: { not: null },
    },
    orderBy: { dueDate: 'asc' },
    take: limit,
    select: { id: true, name: true, dueDate: true, healthStatus: true, progressPercent: true },
  })
}

export async function listAtRiskProjects(ctx: Ctx, scope: 'all' | 'own', limit = 5) {
  return ctx.db.project.findMany({
    where: {
      ...live,
      ...visibilityFilter(ctx, scope),
      status: { notIn: ['COMPLETED', 'ARCHIVED'] },
      healthStatus: { in: ['AT_RISK', 'CRITICAL'] },
    },
    orderBy: { healthScore: 'asc' },
    take: limit,
    select: { id: true, name: true, healthStatus: true, healthScore: true, dueDate: true },
  })
}

/** Projects this member belongs to, for the people module and workload views. */
export async function listProjectsForMembership(ctx: Ctx, membershipId: string) {
  return ctx.db.project.findMany({
    where: {
      ...live,
      status: { notIn: ['ARCHIVED'] },
      OR: [{ managerMembershipId: membershipId }, { members: { some: { membershipId } } }],
    },
    orderBy: { dueDate: 'asc' },
    select: { id: true, key: true, name: true, status: true, healthStatus: true, dueDate: true },
  })
}
