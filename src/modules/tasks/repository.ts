import type { Ctx } from '@/kernel/tenancy/ctx'
import { containsInsensitive, type ListParams } from '@/kernel/validation/list-params'
import { getSystemDb } from '@/lib/db'

import type { TaskSort } from './schema'

/**
 * Task data access.
 *
 * Task visibility follows PROJECT visibility: a task inherits the reach of the
 * project it belongs to, so the filter below joins the project rather than
 * duplicating the rules. Tasks with no project are organization-wide.
 */

const live = { deletedAt: null }

/**
 * Restrict tasks to the projects this actor can see.
 *
 * Expressed as a relation filter so the database does the work; the alternative
 * — fetch, then discard — would leak row counts and waste the index.
 */
export function taskVisibilityFilter(ctx: Ctx, scope: 'all' | 'own') {
  if (scope === 'all') return {}

  return {
    OR: [
      { projectId: null },
      {
        project: {
          OR: [
            { visibility: 'ORGANIZATION' as const },
            { managerMembershipId: ctx.membershipId },
            { members: { some: { membershipId: ctx.membershipId } } },
          ],
        },
      },
    ],
  }
}

/* ------------------------------- numbering -------------------------------- */

/**
 * Allocate the next task number for the organization.
 *
 * Uses a raw atomic UPDATE ... RETURNING so two concurrent creates cannot take
 * the same number. Read-then-write would race under any real load.
 *
 * Runs on the system client because it is raw SQL with the organization bound
 * explicitly as a parameter — the scoped client cannot rewrite raw statements.
 */
export async function nextTaskNumber(organizationId: string): Promise<number> {
  const db = getSystemDb()

  const rows = await db.$queryRaw<Array<{ nextNumber: number }>>`
    INSERT INTO "TaskCounter" ("organizationId", "nextNumber")
    VALUES (${organizationId}, 1)
    ON CONFLICT ("organizationId")
    DO UPDATE SET "nextNumber" = "TaskCounter"."nextNumber" + 1
    RETURNING "nextNumber"
  `

  // The column holds the LAST ISSUED number, so the returned value is this
  // call's number on both paths: 1 on insert, previous + 1 on update.
  // (An earlier version stored the NEXT number and returned the post-update
  // value, which skipped 2 — caught by the sequential-numbering test.)
  return rows[0]?.nextNumber ?? 1
}

/* --------------------------------- reads ---------------------------------- */

export async function listTasks(
  ctx: Ctx,
  params: ListParams<TaskSort>,
  filters: {
    scope: 'all' | 'own'
    projectId?: string | undefined
    status?: string | undefined
    assigneeMembershipId?: string | undefined
    mine?: boolean
    overdue?: boolean
  },
) {
  const where = {
    ...live,
    ...taskVisibilityFilter(ctx, filters.scope),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.mine ? { assigneeMembershipId: ctx.membershipId } : {}),
    ...(filters.assigneeMembershipId ? { assigneeMembershipId: filters.assigneeMembershipId } : {}),
    ...(filters.overdue
      ? { dueDate: { lt: new Date() }, status: { notIn: ['DONE', 'CANCELLED'] as never } }
      : {}),
    ...(params.q ? { title: containsInsensitive(params.q) } : {}),
  }

  const [items, total] = await Promise.all([
    ctx.db.task.findMany({
      where,
      orderBy: { [params.sort.field]: params.sort.direction },
      skip: params.skip,
      take: params.take,
      select: taskListSelect,
    }),
    ctx.db.task.count({ where }),
  ])

  return { items, total }
}

const taskListSelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  priority: true,
  dueDate: true,
  completedAt: true,
  project: { select: { id: true, key: true, name: true } },
  assignee: { select: { id: true, user: { select: { name: true } } } },
  _count: { select: { subtasks: true, comments: true, dependencies: true } },
} as const

/** Board query: one compound index serves it. Capped to bound the payload. */
export async function listBoardTasks(
  ctx: Ctx,
  filters: { scope: 'all' | 'own'; projectId?: string | undefined; mine?: boolean },
  limit = 400,
) {
  return ctx.db.task.findMany({
    where: {
      ...live,
      ...taskVisibilityFilter(ctx, filters.scope),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.mine ? { assigneeMembershipId: ctx.membershipId } : {}),
      status: { not: 'CANCELLED' },
    },
    orderBy: [{ status: 'asc' }, { boardOrder: 'asc' }],
    take: limit,
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      priority: true,
      dueDate: true,
      boardOrder: true,
      project: { select: { id: true, key: true } },
      assignee: { select: { id: true, user: { select: { name: true } } } },
      labels: { select: { label: { select: { id: true, name: true, color: true } } } },
      _count: { select: { dependencies: true, checklist: true } },
    },
  })
}

export async function findTask(ctx: Ctx, id: string, scope: 'all' | 'own') {
  return ctx.db.task.findFirst({
    where: { id, ...live, ...taskVisibilityFilter(ctx, scope) },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      startDate: true,
      dueDate: true,
      estimateMinutes: true,
      spentMinutes: true,
      completedAt: true,
      createdAt: true,
      projectId: true,
      milestoneId: true,
      parentTaskId: true,
      assigneeMembershipId: true,
      project: { select: { id: true, key: true, name: true } },
      milestone: { select: { id: true, name: true } },
      assignee: { select: { id: true, user: { select: { name: true } } } },
      parentTask: { select: { id: true, number: true, title: true } },
      subtasks: {
        where: live,
        orderBy: { number: 'asc' },
        select: { id: true, number: true, title: true, status: true },
      },
      checklist: {
        orderBy: { position: 'asc' },
        select: { id: true, content: true, done: true, position: true },
      },
      labels: { select: { label: { select: { id: true, name: true, color: true } } } },
      comments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          body: true,
          createdAt: true,
          editedAt: true,
          author: { select: { id: true, user: { select: { name: true } } } },
        },
      },
      dependencies: {
        select: {
          id: true,
          type: true,
          dependsOn: { select: { id: true, number: true, title: true, status: true } },
        },
      },
      dependents: {
        select: {
          id: true,
          task: { select: { id: true, number: true, title: true, status: true } },
        },
      },
    },
  })
}

/** Existence check ignoring visibility, for linking and validation. */
export async function taskExists(ctx: Ctx, id: string) {
  return ctx.db.task.findFirst({
    where: { id, ...live },
    select: { id: true, projectId: true, status: true, number: true, title: true },
  })
}

/* --------------------------------- writes --------------------------------- */

export async function createTask(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.task.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, number: true, title: true, status: true },
  })
}

export async function updateTask(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.task.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteTask(ctx: Ctx, id: string) {
  const result = await ctx.db.task.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

/** Neighbours around a drop position, for fractional ranking. */
export async function boardNeighbours(
  ctx: Ctx,
  input: {
    status: string
    projectId?: string | undefined
    beforeId?: string | undefined
    afterId?: string | undefined
  },
) {
  const [before, after] = await Promise.all([
    input.beforeId
      ? ctx.db.task.findFirst({ where: { id: input.beforeId }, select: { boardOrder: true } })
      : Promise.resolve(null),
    input.afterId
      ? ctx.db.task.findFirst({ where: { id: input.afterId }, select: { boardOrder: true } })
      : Promise.resolve(null),
  ])

  return {
    before: before ? Number(before.boardOrder) : null,
    after: after ? Number(after.boardOrder) : null,
  }
}

export async function lastRankInColumn(
  ctx: Ctx,
  status: string,
  projectId?: string | undefined,
): Promise<number | null> {
  const last = await ctx.db.task.findFirst({
    where: { ...live, status: status as never, ...(projectId ? { projectId } : {}) },
    orderBy: { boardOrder: 'desc' },
    select: { boardOrder: true },
  })
  return last ? Number(last.boardOrder) : null
}

export async function tasksInColumn(ctx: Ctx, status: string, projectId?: string | undefined) {
  return ctx.db.task.findMany({
    where: { ...live, status: status as never, ...(projectId ? { projectId } : {}) },
    orderBy: { boardOrder: 'asc' },
    select: { id: true },
  })
}

export async function setRank(ctx: Ctx, id: string, rank: number) {
  await ctx.db.task.updateMany({ where: { id }, data: { boardOrder: rank } })
}

/* ------------------------------ dependencies ------------------------------ */

/** Every dependency edge in the organization, for cycle checking. */
export async function listAllDependencies(ctx: Ctx) {
  return ctx.db.taskDependency.findMany({ select: { taskId: true, dependsOnTaskId: true } })
}

export async function listPrerequisites(ctx: Ctx, taskId: string) {
  const rows = await ctx.db.taskDependency.findMany({
    where: { taskId },
    select: {
      type: true,
      dependsOn: { select: { id: true, title: true, status: true, number: true } },
    },
  })

  return rows.map((row) => ({
    id: row.dependsOn.id,
    title: `${row.dependsOn.number} ${row.dependsOn.title}`,
    status: row.dependsOn.status,
    type: row.type,
  }))
}

export async function addDependency(
  ctx: Ctx,
  input: { taskId: string; dependsOnTaskId: string; type: string },
) {
  return ctx.db.taskDependency.create({
    data: { organizationId: ctx.orgId, ...input, type: input.type as never },
    select: { id: true },
  })
}

export async function removeDependency(ctx: Ctx, taskId: string, dependsOnTaskId: string) {
  const result = await ctx.db.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId } })
  return result.count
}

/* -------------------------- checklist and comments ------------------------ */

export async function addChecklistItem(
  ctx: Ctx,
  input: { taskId: string; content: string; position: number },
) {
  return ctx.db.taskChecklistItem.create({
    data: { organizationId: ctx.orgId, ...input },
    select: { id: true },
  })
}

export async function toggleChecklistItem(ctx: Ctx, id: string, done: boolean) {
  const result = await ctx.db.taskChecklistItem.updateMany({ where: { id }, data: { done } })
  return result.count
}

export async function deleteChecklistItem(ctx: Ctx, id: string) {
  const result = await ctx.db.taskChecklistItem.deleteMany({ where: { id } })
  return result.count
}

export async function nextChecklistPosition(ctx: Ctx, taskId: string): Promise<number> {
  const last = await ctx.db.taskChecklistItem.findFirst({
    where: { taskId },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  return (last?.position ?? -1) + 1
}

export async function addComment(ctx: Ctx, input: { taskId: string; body: string }) {
  return ctx.db.taskComment.create({
    data: {
      organizationId: ctx.orgId,
      taskId: input.taskId,
      body: input.body,
      authorMembershipId: ctx.membershipId,
    },
    select: { id: true },
  })
}

export async function recordMentions(ctx: Ctx, commentId: string, membershipIds: string[]) {
  if (membershipIds.length === 0) return
  await ctx.db.commentMention.createMany({
    data: membershipIds.map((mentionedMembershipId) => ({
      organizationId: ctx.orgId,
      commentId,
      mentionedMembershipId,
    })),
    skipDuplicates: true,
  })
}

/** Members whose names appear as @mentions, resolved inside this organization. */
export async function resolveMentions(ctx: Ctx, names: string[]) {
  if (names.length === 0) return []
  return ctx.db.membership.findMany({
    where: { status: 'ACTIVE', user: { name: { in: names, mode: 'insensitive' } } },
    select: { id: true, user: { select: { name: true } } },
  })
}

/* -------------------------------- labels ---------------------------------- */

export async function listLabels(ctx: Ctx) {
  return ctx.db.label.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, color: true },
  })
}

export async function createLabel(ctx: Ctx, input: { name: string; color: string }) {
  return ctx.db.label.create({
    data: { organizationId: ctx.orgId, ...input },
    select: { id: true, name: true, color: true },
  })
}

export async function setTaskLabel(ctx: Ctx, taskId: string, labelId: string, attach: boolean) {
  if (attach) {
    await ctx.db.taskLabel.upsert({
      where: { taskId_labelId: { taskId, labelId } },
      create: { organizationId: ctx.orgId, taskId, labelId },
      update: {},
    })
  } else {
    await ctx.db.taskLabel.deleteMany({ where: { taskId, labelId } })
  }
}

export async function findLabel(ctx: Ctx, id: string) {
  return ctx.db.label.findFirst({ where: { id }, select: { id: true } })
}

/* ------------------------------- aggregates ------------------------------- */

export async function countTasksByStatus(ctx: Ctx, scope: 'all' | 'own', projectId?: string) {
  return ctx.db.task.groupBy({
    by: ['status'],
    where: { ...live, ...taskVisibilityFilter(ctx, scope), ...(projectId ? { projectId } : {}) },
    _count: { _all: true },
  })
}

export async function countOverdue(ctx: Ctx, scope: 'all' | 'own'): Promise<number> {
  return ctx.db.task.count({
    where: {
      ...live,
      ...taskVisibilityFilter(ctx, scope),
      dueDate: { lt: new Date() },
      status: { notIn: ['DONE', 'CANCELLED'] },
    },
  })
}

export async function countMyOpenTasks(ctx: Ctx): Promise<number> {
  return ctx.db.task.count({
    where: {
      ...live,
      assigneeMembershipId: ctx.membershipId,
      status: { notIn: ['DONE', 'CANCELLED'] },
    },
  })
}

export async function listMyUpcoming(ctx: Ctx, limit = 5) {
  return ctx.db.task.findMany({
    where: {
      ...live,
      assigneeMembershipId: ctx.membershipId,
      status: { notIn: ['DONE', 'CANCELLED'] },
    },
    orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }],
    take: limit,
    select: {
      id: true,
      number: true,
      title: true,
      dueDate: true,
      priority: true,
      project: { select: { key: true } },
    },
  })
}

/** Per-assignee open counts, for the team workload view. */
export async function workloadByAssignee(ctx: Ctx, scope: 'all' | 'own') {
  return ctx.db.task.groupBy({
    by: ['assigneeMembershipId'],
    where: {
      ...live,
      ...taskVisibilityFilter(ctx, scope),
      status: { notIn: ['DONE', 'CANCELLED'] },
      assigneeMembershipId: { not: null },
    },
    _count: { _all: true },
  })
}

/** Task counts for a project, used by project progress and health. */
export async function projectTaskCounts(ctx: Ctx, projectId: string) {
  const [total, completed, overdue] = await Promise.all([
    ctx.db.task.count({ where: { ...live, projectId } }),
    ctx.db.task.count({ where: { ...live, projectId, status: 'DONE' } }),
    ctx.db.task.count({
      where: {
        ...live,
        projectId,
        dueDate: { lt: new Date() },
        status: { notIn: ['DONE', 'CANCELLED'] },
      },
    }),
  ])
  return { total, completed, overdue }
}
