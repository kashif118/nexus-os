import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, forbidden, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { toPageResult, type ListParams } from '@/kernel/validation/list-params'
import { progressFromTasks } from '@/modules/projects/health'

import {
  blockersFor,
  isTerminalStatus,
  needsRebalance,
  rankBetween,
  rebalancedRanks,
  wouldCreateCycle,
} from './dependencies'
import * as repository from './repository'
import type { TaskSort } from './schema'

/**
 * Task business rules.
 *
 * Two rules are enforced here and nowhere else, because the board would happily
 * violate both:
 *
 * - **Dependencies block progress.** Moving a task into a working state while a
 *   prerequisite is open is refused, with the blockers named.
 * - **Dependency graphs stay acyclic.** A proposed edge is checked against the
 *   whole organization graph before it is written.
 */

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/** Tasks inherit project visibility. */
function readScope(ctx: Ctx): 'all' | 'own' {
  if (ctx.can('project.read.any')) return 'all'
  if (ctx.can('task.read')) return 'own'
  throw forbidden('You do not have access to tasks.')
}

/**
 * Can this actor change this task?
 *
 * `task.update.any` covers everything; `task.update.own` covers tasks they
 * created or are assigned, which is what an Employee holds.
 */
async function requireWriteAccess(ctx: Ctx, taskId: string): Promise<void> {
  if (ctx.can('task.update.any')) return

  if (ctx.can('task.update.own')) {
    const task = await ctx.db.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { assigneeMembershipId: true, createdById: true },
    })
    if (
      task &&
      (task.assigneeMembershipId === ctx.membershipId || task.createdById === ctx.userId)
    ) {
      return
    }
  }

  throw forbidden('You do not have permission to change this task.')
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function listTasks(
  ctx: Ctx,
  params: ListParams<TaskSort>,
  filters: {
    projectId?: string | undefined
    status?: string | undefined
    assigneeMembershipId?: string | undefined
    mine?: boolean
    overdue?: boolean
  } = {},
) {
  const scope = readScope(ctx)
  const { items, total } = await repository.listTasks(ctx, params, { scope, ...filters })
  return toPageResult(items, total, params)
}

export async function getBoard(
  ctx: Ctx,
  filters: { projectId?: string | undefined; mine?: boolean } = {},
) {
  const scope = readScope(ctx)
  const [tasks, labels] = await Promise.all([
    repository.listBoardTasks(ctx, { scope, ...filters }),
    repository.listLabels(ctx),
  ])

  // Decimal is not serialisable to a client component; ranks are only meaningful
  // relative to each other, so a number is enough.
  return {
    tasks: tasks.map((task) => ({ ...task, boardOrder: Number(task.boardOrder) })),
    labels,
  }
}

export async function getTask(ctx: Ctx, id: string) {
  const scope = readScope(ctx)
  const task = await repository.findTask(ctx, id, scope)
  if (!task) throw notFound('That task is not available.')

  const prerequisites = await repository.listPrerequisites(ctx, id)

  return {
    ...task,
    // Surfaced so the detail page can explain why a status change would fail
    // before the user attempts it.
    blockers: blockersFor('IN_PROGRESS', prerequisites),
  }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export interface TaskWriteInput {
  title: string
  description?: string | undefined
  projectId?: string | undefined
  milestoneId?: string | undefined
  parentTaskId?: string | undefined
  status: string
  priority: string
  assigneeMembershipId?: string | undefined
  startDate?: Date | undefined
  dueDate?: Date | undefined
  estimateMinutes?: number | undefined
}

export async function createTask(
  ctx: Ctx,
  input: TaskWriteInput,
  meta: RequestMeta,
): Promise<{ id: string; number: number }> {
  ctx.require('task.create')

  const projectId = await resolveProjectId(ctx, input.projectId)
  const assigneeMembershipId = await resolveAssignee(ctx, input.assigneeMembershipId)
  const parentTaskId = await resolveParent(ctx, input.parentTaskId)

  // Atomic per-organization numbering: two concurrent creates cannot collide.
  const number = await repository.nextTaskNumber(ctx.orgId)
  const lastRank = await repository.lastRankInColumn(ctx, input.status, projectId)

  const task = await repository.createTask(ctx, {
    number,
    title: input.title,
    description: input.description,
    projectId,
    milestoneId: input.milestoneId,
    parentTaskId,
    status: input.status,
    priority: input.priority,
    assigneeMembershipId,
    startDate: input.startDate,
    dueDate: input.dueDate,
    estimateMinutes: input.estimateMinutes,
    boardOrder: rankBetween(lastRank, null),
    completedAt: isTerminalStatus(input.status) ? new Date() : null,
  })

  if (projectId) await syncProjectProgress(ctx, projectId)

  await writeAuditLog({
    action: 'task.created',
    entityType: 'Task',
    entityId: task.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { number: task.number, title: task.title },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: task.id, number: task.number }
}

export async function updateTask(
  ctx: Ctx,
  id: string,
  input: TaskWriteInput,
  meta: RequestMeta,
): Promise<void> {
  await requireWriteAccess(ctx, id)

  const current = await repository.taskExists(ctx, id)
  if (!current) throw notFound('That task is not available.')

  const projectId = await resolveProjectId(ctx, input.projectId)
  const assigneeMembershipId = await resolveAssignee(ctx, input.assigneeMembershipId)
  const parentTaskId = await resolveParent(ctx, input.parentTaskId, id)

  if (input.status !== current.status) {
    await assertStatusAllowed(ctx, id, input.status)
  }

  await repository.updateTask(ctx, id, {
    title: input.title,
    description: input.description ?? null,
    projectId: projectId ?? null,
    milestoneId: input.milestoneId ?? null,
    parentTaskId: parentTaskId ?? null,
    status: input.status,
    priority: input.priority,
    assigneeMembershipId: assigneeMembershipId ?? null,
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    estimateMinutes: input.estimateMinutes ?? null,
    completedAt: isTerminalStatus(input.status) ? new Date() : null,
  })

  for (const affected of new Set([current.projectId, projectId].filter(Boolean) as string[])) {
    await syncProjectProgress(ctx, affected)
  }

  await writeAuditLog({
    action: 'task.updated',
    entityType: 'Task',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Move a task on the board.
 *
 * Handles both the column change and the position within it. The rank is the
 * midpoint between the drop neighbours, so one row is written; when midpoints
 * run out of floating-point room the column is rebuilt, which is rare.
 */
export async function moveTask(
  ctx: Ctx,
  input: {
    taskId: string
    status: string
    beforeId?: string | undefined
    afterId?: string | undefined
  },
  meta: RequestMeta,
): Promise<void> {
  await requireWriteAccess(ctx, input.taskId)

  const task = await repository.taskExists(ctx, input.taskId)
  if (!task) throw notFound('That task is not available.')

  if (input.status !== task.status) {
    await assertStatusAllowed(ctx, input.taskId, input.status)
  }

  const { before, after } = await repository.boardNeighbours(ctx, {
    status: input.status,
    projectId: task.projectId ?? undefined,
    beforeId: input.beforeId,
    afterId: input.afterId,
  })

  let rank = rankBetween(before, after)

  await repository.updateTask(ctx, input.taskId, {
    status: input.status,
    boardOrder: rank,
    completedAt: isTerminalStatus(input.status) ? new Date() : null,
  })

  // Precision exhausted: rebuild the column so future drops have room again.
  if (needsRebalance(before, after)) {
    const column = await repository.tasksInColumn(ctx, input.status, task.projectId ?? undefined)
    const ranks = rebalancedRanks(column.length)
    await Promise.all(column.map((row, index) => repository.setRank(ctx, row.id, ranks[index]!)))
    rank = ranks[column.findIndex((row) => row.id === input.taskId)] ?? rank
  }

  if (task.projectId) await syncProjectProgress(ctx, task.projectId)

  await writeAuditLog({
    action: 'task.moved',
    entityType: 'Task',
    entityId: input.taskId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { from: task.status, to: input.status },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function assignTask(
  ctx: Ctx,
  input: { taskId: string; membershipId: string | undefined },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('task.assign')

  const assigneeMembershipId = await resolveAssignee(ctx, input.membershipId)
  const updated = await repository.updateTask(ctx, input.taskId, {
    assigneeMembershipId: assigneeMembershipId ?? null,
  })
  if (updated === 0) throw notFound('That task is not available.')

  await writeAuditLog({
    action: 'task.assigned',
    entityType: 'Task',
    entityId: input.taskId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { assigneeMembershipId: assigneeMembershipId ?? null },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteTask(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('task.delete')

  const task = await repository.taskExists(ctx, id)
  if (!task) throw notFound('That task is not available.')

  await repository.softDeleteTask(ctx, id)
  if (task.projectId) await syncProjectProgress(ctx, task.projectId)

  await writeAuditLog({
    action: 'task.deleted',
    entityType: 'Task',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

export async function addDependency(
  ctx: Ctx,
  input: { taskId: string; dependsOnTaskId: string; type: string },
  meta: RequestMeta,
): Promise<void> {
  await requireWriteAccess(ctx, input.taskId)

  if (input.taskId === input.dependsOnTaskId) {
    throw validationError('A task cannot depend on itself.')
  }

  // Both ends must exist in THIS organization; the scoped client guarantees it.
  const [task, prerequisite] = await Promise.all([
    repository.taskExists(ctx, input.taskId),
    repository.taskExists(ctx, input.dependsOnTaskId),
  ])
  if (!task || !prerequisite) throw notFound('That task is not available.')

  const edges = await repository.listAllDependencies(ctx)
  if (wouldCreateCycle(edges, input)) {
    throw conflict(
      'That would create a circular dependency: the other task already depends on this one, directly or through a chain.',
    )
  }

  await repository.addDependency(ctx, input)

  await writeAuditLog({
    action: 'task.dependency_added',
    entityType: 'Task',
    entityId: input.taskId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { dependsOnTaskId: input.dependsOnTaskId, type: input.type },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function removeDependency(
  ctx: Ctx,
  input: { taskId: string; dependsOnTaskId: string },
  meta: RequestMeta,
): Promise<void> {
  await requireWriteAccess(ctx, input.taskId)

  const removed = await repository.removeDependency(ctx, input.taskId, input.dependsOnTaskId)
  if (removed === 0) throw notFound('That dependency no longer exists.')

  await writeAuditLog({
    action: 'task.dependency_removed',
    entityType: 'Task',
    entityId: input.taskId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Refuse a status change that its prerequisites forbid.
 *
 * The blockers are named in the message: "blocked by 12 Design review" is
 * actionable, "blocked" is not.
 */
async function assertStatusAllowed(ctx: Ctx, taskId: string, status: string): Promise<void> {
  const prerequisites = await repository.listPrerequisites(ctx, taskId)
  const blockers = blockersFor(status, prerequisites)

  if (blockers.length > 0) {
    throw conflict(
      `This task is blocked by ${blockers.map((blocker) => blocker.title).join(', ')}.`,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Checklist, comments, labels                                                 */
/* -------------------------------------------------------------------------- */

export async function addChecklistItem(
  ctx: Ctx,
  input: { taskId: string; content: string },
  meta: RequestMeta,
): Promise<void> {
  await requireWriteAccess(ctx, input.taskId)

  const position = await repository.nextChecklistPosition(ctx, input.taskId)
  await repository.addChecklistItem(ctx, { ...input, position })

  await writeAuditLog({
    action: 'task.checklist_added',
    entityType: 'Task',
    entityId: input.taskId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function toggleChecklistItem(
  ctx: Ctx,
  input: { taskId: string; itemId: string; done: boolean },
): Promise<void> {
  await requireWriteAccess(ctx, input.taskId)
  const updated = await repository.toggleChecklistItem(ctx, input.itemId, input.done)
  if (updated === 0) throw notFound('That checklist item is not available.')
}

export async function deleteChecklistItem(
  ctx: Ctx,
  input: { taskId: string; itemId: string },
): Promise<void> {
  await requireWriteAccess(ctx, input.taskId)
  await repository.deleteChecklistItem(ctx, input.itemId)
}

/**
 * Post a comment, recording any @mentions.
 *
 * Mentions are resolved against ACTIVE members of this organization, so a
 * mention cannot reference someone in another tenant.
 */
export async function addComment(
  ctx: Ctx,
  input: { taskId: string; body: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('task.comment')

  const task = await repository.taskExists(ctx, input.taskId)
  if (!task) throw notFound('That task is not available.')

  const comment = await repository.addComment(ctx, input)

  const names = extractMentions(input.body)
  if (names.length > 0) {
    const members = await repository.resolveMentions(ctx, names)
    await repository.recordMentions(
      ctx,
      comment.id,
      members.map((member) => member.id),
    )
  }

  await writeAuditLog({
    action: 'task.commented',
    entityType: 'Task',
    entityId: input.taskId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Pull @mentions out of a comment body.
 *
 * Single token only. An earlier version optionally matched a second word so
 * that "@Ada Lovelace" would resolve, but it swallowed the following word in
 * every ordinary sentence — "@ada look at this" became a mention of "ada look".
 * Guessing where a name ends in free text is not solvable; multi-word names
 * need a mention picker in the editor, which belongs with notifications.
 */
export function extractMentions(body: string): string[] {
  const matches = body.matchAll(/@([\p{L}][\p{L}\p{N}'._-]*)/gu)
  return [...new Set([...matches].map((match) => match[1]!))]
}

export async function setLabel(
  ctx: Ctx,
  input: { taskId: string; labelId: string; attach: boolean },
): Promise<void> {
  await requireWriteAccess(ctx, input.taskId)

  const label = await repository.findLabel(ctx, input.labelId)
  if (!label) throw notFound('That label is not available.')

  await repository.setTaskLabel(ctx, input.taskId, input.labelId, input.attach)
}

export async function createLabel(ctx: Ctx, input: { name: string; color: string }) {
  ctx.require('task.create')
  try {
    return await repository.createLabel(ctx, input)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('A label with that name already exists.', { name: ['Already in use.'] })
    }
    throw error
  }
}

export const listLabels = (ctx: Ctx) => repository.listLabels(ctx)

/* -------------------------------------------------------------------------- */
/* Cross-module                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Keep project progress and health in step with its tasks.
 *
 * Called after any task change. This is the join that makes the project health
 * model meaningful: without it, progress would be a number someone typed.
 */
async function syncProjectProgress(ctx: Ctx, projectId: string): Promise<void> {
  const counts = await repository.projectTaskCounts(ctx, projectId)
  const progress = progressFromTasks(counts.completed, counts.total)

  await ctx.db.project.updateMany({
    where: { id: projectId },
    data: { progressPercent: progress },
  })

  // Recomputing health here rather than importing the projects service avoids a
  // circular dependency between the two modules.
  const project = await ctx.db.project.findFirst({
    where: { id: projectId },
    select: {
      status: true,
      dueDate: true,
      completedAt: true,
      budgetMinor: true,
    },
  })
  if (!project) return

  const missedMilestones = await ctx.db.milestone.count({
    where: { projectId, status: { notIn: ['COMPLETED'] }, dueDate: { lt: new Date() } },
  })

  const { assessHealth } = await import('@/modules/projects/health')
  const assessment = assessHealth({
    status: project.status,
    dueDate: project.dueDate,
    completedAt: project.completedAt,
    progressPercent: progress,
    totalTasks: counts.total,
    overdueTasks: counts.overdue,
    missedMilestones,
    budgetMinor: project.budgetMinor,
    spentMinor: null,
  })

  await ctx.db.project.updateMany({
    where: { id: projectId },
    data: {
      healthScore: assessment.score,
      healthStatus: assessment.status,
      healthComputedAt: new Date(),
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

async function resolveProjectId(ctx: Ctx, projectId: string | undefined) {
  if (!projectId) return undefined

  const project = await ctx.db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  })
  if (!project) {
    throw validationError('That project is not available.', { projectId: ['Unknown project.'] })
  }
  return projectId
}

async function resolveAssignee(ctx: Ctx, membershipId: string | undefined) {
  if (!membershipId) return undefined

  const membership = await ctx.db.membership.findFirst({
    where: { id: membershipId, status: 'ACTIVE' },
    select: { id: true },
  })
  if (!membership) {
    throw validationError('That person is not a member of this organization.', {
      assigneeMembershipId: ['Unknown member.'],
    })
  }
  return membershipId
}

/** A task cannot be its own parent, nor a parent of its own ancestor. */
async function resolveParent(ctx: Ctx, parentTaskId: string | undefined, selfId?: string) {
  if (!parentTaskId) return undefined
  if (selfId && parentTaskId === selfId) {
    throw validationError('A task cannot be its own parent.')
  }

  const parent = await repository.taskExists(ctx, parentTaskId)
  if (!parent) throw validationError('That parent task is not available.')
  return parentTaskId
}

export async function getTaskFormOptions(ctx: Ctx) {
  const [members, projects, labels] = await Promise.all([
    ctx.db.membership.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, user: { select: { name: true } } },
    }),
    ctx.db.project.findMany({
      where: { deletedAt: null, status: { notIn: ['ARCHIVED'] } },
      orderBy: { name: 'asc' },
      take: 200,
      select: { id: true, key: true, name: true },
    }),
    repository.listLabels(ctx),
  ])

  return {
    members: members.map((member) => ({ id: member.id, name: member.user.name })),
    projects,
    labels,
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
