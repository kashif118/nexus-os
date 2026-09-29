import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'

import './builtin-actions'
import './triggers'

import { executeRun } from './engine'
import { emptyGraph, graphSchema, triggerNode, type WorkflowGraph } from './graph'
import { getTrigger, listActions, listTriggers } from './registry'
import * as repository from './repository'
import { validateGraph } from './validate'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * Workflows.
 *
 * The rule that shapes this file: **a workflow can never do more than the
 * person who owns it**. Publishing checks the owner's permissions against every
 * action in the graph and refuses if any are missing; the engine re-checks at
 * run time, because an owner can lose a permission after publishing.
 */

export const availableTriggers = () =>
  listTriggers().map((trigger) => ({
    type: trigger.type,
    label: trigger.label,
    description: trigger.description,
    entityType: trigger.entityType,
    fields: trigger.fields,
  }))

export const availableActions = () =>
  listActions().map((action) => ({
    type: action.type,
    label: action.label,
    description: action.description,
    category: action.category,
    requiredPermissions: action.requiredPermissions,
    sideEffect: action.sideEffect,
    idempotent: action.idempotent,
  }))

export async function listWorkflows(ctx: Ctx) {
  ctx.require('workflow.read')
  return repository.listWorkflows(ctx)
}

export async function getWorkflow(ctx: Ctx, id: string) {
  ctx.require('workflow.read')

  const workflow = await repository.findWorkflow(ctx, id)
  if (!workflow) throw notFound('That workflow is not available.')

  const validation = validateGraph(workflow.draftGraph, {
    ownerPermissions: new Set(ownerPermissionKeys(ctx)),
  })

  return { ...workflow, validation }
}

export async function createWorkflow(
  ctx: Ctx,
  input: { name: string; description?: string | undefined; triggerType: string },
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('workflow.create')

  if (!getTrigger(input.triggerType)) {
    throw validationError('That trigger does not exist.', { triggerType: ['Choose a trigger.'] })
  }

  try {
    const workflow = await repository.createWorkflow(ctx, {
      name: input.name,
      description: input.description ?? null,
      triggerType: input.triggerType,
      status: 'DRAFT',
      draftGraph: emptyGraph(input.triggerType) as never,
    })

    await writeAuditLog({
      action: 'workflow.created',
      entityType: 'Workflow',
      entityId: workflow.id,
      organizationId: ctx.orgId,
      actorId: ctx.userId,
      metadata: { name: workflow.name, triggerType: input.triggerType },
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    return { id: workflow.id }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('A workflow with that name already exists.', { name: ['Already in use.'] })
    }
    throw error
  }
}

/** Replace the draft graph. Validated but not required to be publishable. */
export async function saveDraft(
  ctx: Ctx,
  id: string,
  graph: unknown,
  meta: RequestMeta,
): Promise<{ valid: boolean; issues: string[] }> {
  ctx.require('workflow.update')

  const workflow = await repository.findWorkflow(ctx, id)
  if (!workflow) throw notFound('That workflow is not available.')

  const parsed = graphSchema.safeParse(graph)
  if (!parsed.success) {
    throw validationError('That graph could not be read.', {
      graph: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    })
  }

  // The trigger on the graph is the authority; the column is a denormalised
  // copy kept in step so event matching stays one indexed lookup.
  const trigger = triggerNode(parsed.data)

  await repository.updateWorkflow(ctx, id, {
    draftGraph: parsed.data as never,
    ...(trigger ? { triggerType: trigger.trigger } : {}),
  })

  await writeAuditLog({
    action: 'workflow.draft_saved',
    entityType: 'Workflow',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  const validation = validateGraph(parsed.data, {
    ownerPermissions: new Set(ownerPermissionKeys(ctx)),
  })

  return { valid: validation.valid, issues: validation.issues.map((issue) => issue.message) }
}

/**
 * Publish the draft.
 *
 * Creates an immutable version and points the workflow at it. A run in flight
 * keeps the version it started on, so editing never changes the rules a running
 * workflow is following.
 */
export async function publishWorkflow(
  ctx: Ctx,
  id: string,
  meta: RequestMeta,
): Promise<{ version: number }> {
  ctx.require('workflow.update')

  const workflow = await repository.findWorkflow(ctx, id)
  if (!workflow) throw notFound('That workflow is not available.')

  const validation = validateGraph(workflow.draftGraph, {
    ownerPermissions: new Set(ownerPermissionKeys(ctx)),
  })

  if (!validation.valid) {
    throw validationError('This workflow cannot be published yet.', {
      graph: validation.issues.map((issue) =>
        issue.nodeId ? `${issue.nodeId}: ${issue.message}` : issue.message,
      ),
    })
  }

  const graph = workflow.draftGraph as unknown as WorkflowGraph
  const trigger = triggerNode(graph)
  if (!trigger) throw validationError('This workflow has no trigger.')

  const version = await repository.nextVersionNumber(ctx, id)

  const created = await repository.createVersion(ctx, {
    workflowId: id,
    version,
    graph: graph as never,
    triggerType: trigger.trigger,
  })

  await repository.updateWorkflow(ctx, id, {
    publishedVersionId: created.id,
    triggerType: trigger.trigger,
    // Publishing an archived workflow would be surprising, so it activates only
    // from DRAFT or PAUSED.
    ...(workflow.status === 'ARCHIVED' ? {} : { status: 'ACTIVE' }),
    // The publisher becomes the owner: they are the person whose permissions
    // the workflow will act with, and they have just proved they hold them.
    ownerMembershipId: ctx.membershipId,
  })

  await writeAuditLog({
    action: 'workflow.published',
    entityType: 'Workflow',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { version: String(version) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { version }
}

export async function setStatus(
  ctx: Ctx,
  id: string,
  status: 'ACTIVE' | 'PAUSED',
  meta: RequestMeta,
): Promise<void> {
  ctx.require('workflow.update')

  const workflow = await repository.findWorkflow(ctx, id)
  if (!workflow) throw notFound('That workflow is not available.')

  if (status === 'ACTIVE' && !workflow.publishedVersionId) {
    throw conflict('Publish this workflow before activating it.')
  }

  await repository.updateWorkflow(ctx, id, { status })

  await writeAuditLog({
    action: status === 'ACTIVE' ? 'workflow.activated' : 'workflow.paused',
    entityType: 'Workflow',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function deleteWorkflow(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('workflow.delete')

  const removed = await repository.softDeleteWorkflow(ctx, id)
  if (removed === 0) throw notFound('That workflow is not available.')

  await writeAuditLog({
    action: 'workflow.deleted',
    entityType: 'Workflow',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* ----------------------------------- runs ---------------------------------- */

export const listRuns = (ctx: Ctx, workflowId?: string) => {
  ctx.require('workflow.read')
  return repository.listRuns(ctx, workflowId)
}

export async function getRun(ctx: Ctx, id: string) {
  ctx.require('workflow.read')

  const run = await repository.findRun(ctx, id)
  if (!run) throw notFound('That run is not available.')
  return run
}

/**
 * Run a workflow by hand against a sample payload.
 *
 * `dryRun` is the default: a test run describes what each action would do and
 * performs none of it. Running for real is a separate, explicit choice.
 */
export async function runManually(
  ctx: Ctx,
  input: { workflowId: string; payload?: Record<string, unknown>; dryRun?: boolean },
  meta: RequestMeta,
): Promise<{ runId: string; status: string }> {
  ctx.require('workflow.run')

  const workflow = await repository.findWorkflow(ctx, input.workflowId)
  if (!workflow) throw notFound('That workflow is not available.')
  if (!workflow.publishedVersionId) {
    throw conflict('Publish this workflow before running it.')
  }

  const run = await repository.createManualRun(ctx, {
    workflowId: workflow.id,
    versionId: workflow.publishedVersionId,
    status: 'QUEUED',
    triggerType: 'manual',
    triggerEvent: {
      payload: input.payload ?? {},
      manual: true,
      dryRun: input.dryRun ?? true,
    } as never,
  })

  const outcome = await executeRun(run.id, { dryRun: input.dryRun ?? true })

  await writeAuditLog({
    action: 'workflow.run_manually',
    entityType: 'Workflow',
    entityId: workflow.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { runId: run.id, dryRun: String(input.dryRun ?? true) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { runId: run.id, status: outcome.status }
}

/* -------------------------------- approvals -------------------------------- */

export const listPendingApprovals = (ctx: Ctx) => {
  ctx.require('workflow.read')
  return repository.pendingApprovals(ctx)
}

/**
 * Decide an approval step and let the run continue.
 *
 * The decision is written to the step, then the run is re-queued; the
 * interpreter reads the decision on its next pass and takes the matching
 * branch. Nothing about the run's future is decided here, which keeps one
 * authority over what a graph means.
 */
export async function decideApproval(
  ctx: Ctx,
  input: { stepId: string; approve: boolean },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('workflow.approve')

  const step = await repository.findApprovalStep(ctx, input.stepId)
  if (!step) throw notFound('That approval is not available.')
  if (step.status !== 'WAITING') throw conflict('That approval has already been decided.')

  const recorded = await repository.recordApprovalDecision(
    ctx,
    input.stepId,
    input.approve ? 'APPROVED' : 'REJECTED',
  )
  if (recorded === 0) throw conflict('That approval has already been decided.')

  await repository.releaseRun(step.runId)
  await executeRun(step.runId)

  await writeAuditLog({
    action: input.approve ? 'workflow.approval_granted' : 'workflow.approval_rejected',
    entityType: 'WorkflowRun',
    entityId: step.runId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */

/**
 * The permission keys the current actor holds.
 *
 * Used to validate a graph against the person who is publishing it — they
 * become the owner, so their permissions are the ceiling on what it can do.
 */
function ownerPermissionKeys(ctx: Ctx): string[] {
  if (ctx.isOwner) {
    // An organization owner holds everything; listing them is unnecessary, and
    // the validator only ever checks membership of this set.
    return listActions().flatMap((action) => action.requiredPermissions)
  }

  return listActions()
    .flatMap((action) => action.requiredPermissions)
    .filter((permission) => ctx.can(permission))
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
