import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

const live = { deletedAt: null }

export async function listWorkflows(ctx: Ctx) {
  return ctx.db.workflow.findMany({
    where: live,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      triggerType: true,
      status: true,
      updatedAt: true,
      publishedVersionId: true,
      owner: { select: { id: true, user: { select: { name: true } } } },
      _count: { select: { runs: true } },
    },
  })
}

export async function findWorkflow(ctx: Ctx, id: string) {
  return ctx.db.workflow.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      name: true,
      description: true,
      triggerType: true,
      status: true,
      draftGraph: true,
      publishedVersionId: true,
      ownerMembershipId: true,
      createdAt: true,
      updatedAt: true,
      owner: { select: { id: true, user: { select: { name: true } } } },
      published: { select: { id: true, version: true, createdAt: true } },
    },
  })
}

export async function createWorkflow(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.workflow.create({
    data: {
      ...data,
      organizationId: ctx.orgId,
      createdById: ctx.userId,
      ownerMembershipId: ctx.membershipId,
    } as never,
    select: { id: true, name: true },
  })
}

export async function updateWorkflow(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.workflow.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteWorkflow(ctx: Ctx, id: string) {
  const result = await ctx.db.workflow.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date(), status: 'ARCHIVED' },
  })
  return result.count
}

export async function nextVersionNumber(ctx: Ctx, workflowId: string): Promise<number> {
  const latest = await ctx.db.workflowVersion.findFirst({
    where: { workflowId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  return (latest?.version ?? 0) + 1
}

export async function createVersion(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.workflowVersion.create({
    data: { ...data, organizationId: ctx.orgId, publishedById: ctx.userId } as never,
    select: { id: true, version: true },
  })
}

/* ----------------------------------- runs ---------------------------------- */

export async function listRuns(ctx: Ctx, workflowId?: string, limit = 25) {
  return ctx.db.workflowRun.findMany({
    where: workflowId ? { workflowId } : {},
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      triggerType: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      workflow: { select: { id: true, name: true } },
      version: { select: { version: true } },
      _count: { select: { steps: true } },
    },
  })
}

export async function findRun(ctx: Ctx, id: string) {
  return ctx.db.workflowRun.findFirst({
    where: { id },
    select: {
      id: true,
      status: true,
      triggerType: true,
      triggerEvent: true,
      context: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      resumeAt: true,
      workflow: { select: { id: true, name: true } },
      version: { select: { version: true, graph: true } },
      steps: {
        orderBy: { startedAt: 'asc' },
        select: {
          id: true,
          nodeId: true,
          nodeType: true,
          kind: true,
          status: true,
          input: true,
          output: true,
          error: true,
          attempts: true,
          approvalDecision: true,
          approvalDeadline: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
        },
      },
    },
  })
}

export async function createManualRun(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.workflowRun.create({
    data: { ...data, organizationId: ctx.orgId } as never,
    select: { id: true },
  })
}

/** Approval steps awaiting a decision, for the approvals queue. */
export async function pendingApprovals(ctx: Ctx, limit = 25) {
  return ctx.db.workflowRunStep.findMany({
    where: { nodeType: 'approval', status: 'WAITING' },
    orderBy: { startedAt: 'asc' },
    take: limit,
    select: {
      id: true,
      runId: true,
      nodeId: true,
      approvalDeadline: true,
      startedAt: true,
      run: {
        select: {
          id: true,
          status: true,
          workflow: { select: { id: true, name: true } },
        },
      },
    },
  })
}

export async function findApprovalStep(ctx: Ctx, stepId: string) {
  return ctx.db.workflowRunStep.findFirst({
    where: { id: stepId, nodeType: 'approval' },
    select: {
      id: true,
      runId: true,
      status: true,
      approvalDecision: true,
      run: { select: { id: true, status: true } },
    },
  })
}

export async function recordApprovalDecision(
  ctx: Ctx,
  stepId: string,
  decision: 'APPROVED' | 'REJECTED',
) {
  const result = await ctx.db.workflowRunStep.updateMany({
    where: { id: stepId, nodeType: 'approval', status: 'WAITING' },
    data: { approvalDecision: decision, approvedById: ctx.membershipId },
  })
  return result.count
}

/**
 * Release a run that was waiting on an approval.
 *
 * Uses the system client: the run is identified by a row the caller has already
 * been authorised against, and the update sets only the scheduling fields.
 */
export async function releaseRun(runId: string): Promise<void> {
  await getSystemDb().workflowRun.update({
    where: { id: runId },
    data: { status: 'QUEUED', resumeAt: null },
  })
}
