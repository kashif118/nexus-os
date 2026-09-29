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
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb } from '@/lib/db'

import './builtin-actions'
import './triggers'

import { evaluate } from './conditions'
import { graphSchema, outgoing, triggerNode, type WorkflowGraph, type WorkflowNode } from './graph'
import { getAction, getTrigger } from './registry'

/**
 * The workflow interpreter.
 *
 * It walks a published graph from its trigger, writing one row per node as it
 * goes. The design constraints, and why each exists:
 *
 * - **Resumable.** An approval waits for a person and a delay waits for the
 *   clock, both of which outlive the request and often the deployment. State
 *   lives in `WorkflowRunStep` rows, so `resumeRun` can pick a run up cold.
 * - **Idempotent per step.** `(runId, nodeId)` is unique. A replay finds a
 *   completed step and skips it, so a retried run does not send the email twice.
 * - **Bounded.** A step budget stops a pathological graph, and causation depth
 *   stops a workflow from triggering itself through its own side effects.
 * - **Owner-scoped.** Actions run as the workflow owner, through the org-scoped
 *   client. A workflow can never do more than the person who owns it.
 */

const MAX_STEPS_PER_RUN = 100
const MAX_CAUSATION_DEPTH = 3

export interface RunOutcome {
  runId: string
  status: 'SUCCEEDED' | 'FAILED' | 'WAITING' | 'CANCELLED'
  steps: number
  error?: string
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Start a run for every active workflow whose trigger matches this event.
 *
 * Called by the outbox subscriber. The organization comes from the event, which
 * was written inside that organization's own transaction.
 */
export async function startRunsForEvent(event: {
  id: string
  type: string
  organizationId: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
}): Promise<string[]> {
  const triggers = triggersForEventType(event.type)
  if (triggers.length === 0) return []

  const db = getSystemDb()

  const workflows = await db.workflow.findMany({
    where: {
      organizationId: event.organizationId,
      status: 'ACTIVE',
      deletedAt: null,
      triggerType: { in: triggers },
      publishedVersionId: { not: null },
    },
    select: { id: true, publishedVersionId: true, ownerMembershipId: true },
  })

  const runIds: string[] = []

  for (const workflow of workflows) {
    if (!workflow.publishedVersionId) continue

    const run = await db.workflowRun.create({
      data: {
        organizationId: event.organizationId,
        workflowId: workflow.id,
        versionId: workflow.publishedVersionId,
        status: 'QUEUED',
        triggerType: event.type,
        triggerEvent: {
          eventId: event.id,
          entityType: event.entityType,
          entityId: event.entityId,
          payload: event.payload,
        } as never,
        causationDepth: 0,
      },
      select: { id: true },
    })

    runIds.push(run.id)
  }

  return runIds
}

function triggersForEventType(eventType: string): string[] {
  // A trigger's type happens to equal its event type for every built-in
  // trigger, but the registry is still the authority — a future trigger may
  // listen to several events.
  const matching: string[] = []
  for (const trigger of [getTrigger(eventType)].filter(Boolean)) {
    if (trigger) matching.push(trigger.type)
  }
  return matching
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

/** Execute specific runs. Used by the subscriber for the runs it just created. */
export async function runSpecific(runIds: string[]): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = []
  for (const runId of runIds) {
    outcomes.push(await executeRun(runId))
  }
  return outcomes
}

/**
 * Execute every queued run, oldest first.
 *
 * `organizationId` narrows the sweep to one tenant — unused in production,
 * where sweeping everything is correct, and what lets an integration suite work
 * on only its own runs while other suites share the database.
 */
export async function runQueued(limit = 20, organizationId?: string): Promise<RunOutcome[]> {
  const db = getSystemDb()

  const queued = await db.workflowRun.findMany({
    where: { status: 'QUEUED', ...(organizationId ? { organizationId } : {}) },
    orderBy: { startedAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  const outcomes: RunOutcome[] = []
  for (const run of queued) {
    outcomes.push(await executeRun(run.id))
  }
  return outcomes
}

/** Resume runs whose delay has elapsed. */
export async function resumeDueRuns(limit = 20, organizationId?: string): Promise<RunOutcome[]> {
  const db = getSystemDb()

  const due = await db.workflowRun.findMany({
    where: {
      status: 'WAITING',
      resumeAt: { lte: new Date() },
      ...(organizationId ? { organizationId } : {}),
    },
    orderBy: { resumeAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  const outcomes: RunOutcome[] = []
  for (const run of due) {
    outcomes.push(await executeRun(run.id))
  }
  return outcomes
}

/**
 * Execute or resume one run.
 *
 * `dryRun` is threaded all the way to the actions, which then describe their
 * effect instead of performing it — so "test this workflow" is genuinely safe
 * rather than safe-looking.
 */
export async function executeRun(runId: string, { dryRun = false } = {}): Promise<RunOutcome> {
  const db = getSystemDb()

  const run = await db.workflowRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      causationDepth: true,
      triggerEvent: true,
      context: true,
      version: { select: { graph: true } },
      workflow: { select: { id: true, name: true, ownerMembershipId: true } },
    },
  })

  if (!run) return { runId, status: 'FAILED', steps: 0, error: 'Run not found.' }

  if (run.status === 'SUCCEEDED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
    return { runId, status: run.status, steps: 0 }
  }

  if (run.causationDepth > MAX_CAUSATION_DEPTH) {
    return finish(runId, 'CANCELLED', 0, 'Causation depth exceeded: a workflow chain looped.')
  }

  const parsed = graphSchema.safeParse(run.version.graph)
  if (!parsed.success) {
    return finish(runId, 'FAILED', 0, 'The published graph is not valid.')
  }

  const graph = parsed.data
  const trigger = triggerNode(graph)
  if (!trigger) return finish(runId, 'FAILED', 0, 'The published graph has no trigger.')

  if (!run.workflow.ownerMembershipId) {
    return finish(runId, 'FAILED', 0, 'This workflow has no owner, so it cannot act.')
  }

  const ctx = await buildOwnerContext(run.organizationId, run.workflow.ownerMembershipId)
  if (!ctx) return finish(runId, 'FAILED', 0, 'The workflow owner is no longer an active member.')

  await db.workflowRun.update({ where: { id: runId }, data: { status: 'RUNNING', error: null } })

  const triggerEvent = (run.triggerEvent ?? {}) as { payload?: Record<string, unknown> }
  const triggerDefinition = getTrigger(trigger.trigger)
  const fields = triggerDefinition?.toFields(triggerEvent.payload ?? {}) ?? {}

  const data: Record<string, unknown> = {
    ...((run.context ?? {}) as Record<string, unknown>),
    ...fields,
    workflowName: run.workflow.name,
  }

  // Completed steps from an earlier pass are skipped, which is what makes a
  // resumed run safe: the email that was already sent is not sent again.
  const existing = await db.workflowRunStep.findMany({
    where: { runId },
    select: { nodeId: true, status: true, output: true },
  })

  const done = new Map(existing.map((step) => [step.nodeId, step]))
  for (const step of existing) {
    if (step.output && typeof step.output === 'object') {
      Object.assign(data, step.output as Record<string, unknown>)
    }
  }

  let executed = 0
  const queue: Array<{ nodeId: string; branch?: string }> = [{ nodeId: trigger.id }]
  const visited = new Set<string>()

  while (queue.length > 0) {
    if (executed >= MAX_STEPS_PER_RUN) {
      return finish(runId, 'FAILED', executed, 'Step budget exceeded.')
    }

    const current = queue.shift()!
    if (visited.has(current.nodeId)) continue
    visited.add(current.nodeId)

    const node = graph.nodes.find((candidate) => candidate.id === current.nodeId)
    if (!node) continue

    const previous = done.get(node.id)
    if (previous?.status === 'SUCCEEDED') {
      // Already done on an earlier pass: follow its edges without repeating it.
      for (const edge of outgoing(graph, node.id)) queue.push({ nodeId: edge.to })
      continue
    }

    const result = await executeNode({
      node,
      graph,
      ctx,
      runId,
      data,
      dryRun,
      organizationId: run.organizationId,
    })
    executed += 1

    if (result.kind === 'wait') {
      await db.workflowRun.update({
        where: { id: runId },
        data: {
          status: 'WAITING',
          resumeAt: result.resumeAt ?? null,
          context: data as never,
        },
      })
      return { runId, status: 'WAITING', steps: executed }
    }

    if (result.kind === 'fail') {
      return finish(runId, 'FAILED', executed, result.error)
    }

    if (result.kind === 'stop') continue

    for (const edge of outgoing(graph, node.id, result.branch)) {
      queue.push({ nodeId: edge.to })
    }
  }

  await db.workflowRun.update({
    where: { id: runId },
    data: { status: 'SUCCEEDED', finishedAt: new Date(), context: data as never },
  })

  return { runId, status: 'SUCCEEDED', steps: executed }
}

type NodeResult =
  | { kind: 'continue'; branch?: string | undefined }
  | { kind: 'stop' }
  | { kind: 'wait'; resumeAt?: Date | undefined }
  | { kind: 'fail'; error: string }

async function executeNode({
  node,
  graph,
  ctx,
  runId,
  data,
  dryRun,
  organizationId,
}: {
  node: WorkflowNode
  graph: WorkflowGraph
  ctx: Ctx
  runId: string
  data: Record<string, unknown>
  dryRun: boolean
  organizationId: string
}): Promise<NodeResult> {
  const db = getSystemDb()
  const startedAt = Date.now()

  const step = await db.workflowRunStep.upsert({
    where: { runId_nodeId: { runId, nodeId: node.id } },
    create: {
      organizationId,
      runId,
      nodeId: node.id,
      nodeType: node.type,
      kind: node.type === 'action' ? node.action : node.type === 'trigger' ? node.trigger : null,
      status: 'RUNNING',
      attempts: 1,
    },
    update: { status: 'RUNNING', attempts: { increment: 1 }, error: null },
    select: { id: true, attempts: true, approvalDecision: true, approvalDeadline: true },
  })

  const settle = async (
    status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'WAITING',
    extra: Record<string, unknown> = {},
  ) => {
    await db.workflowRunStep.update({
      where: { id: step.id },
      data: {
        status,
        finishedAt: status === 'WAITING' ? null : new Date(),
        durationMs: Date.now() - startedAt,
        ...extra,
      } as never,
    })
  }

  switch (node.type) {
    case 'trigger':
      await settle('SUCCEEDED')
      return { kind: 'continue' }

    case 'condition': {
      const passed = evaluate(node.expression, { fields: data as never })
      await settle(passed ? 'SUCCEEDED' : 'SKIPPED', { output: { passed } })
      // A false condition stops THIS path, not the run: another branch may still
      // have work to do.
      return passed ? { kind: 'continue' } : { kind: 'stop' }
    }

    case 'delay': {
      const resumeAt = new Date(Date.now() + node.config.seconds * 1000)

      if (dryRun) {
        await settle('SUCCEEDED', { output: { wouldWaitUntil: resumeAt.toISOString() } })
        return { kind: 'continue' }
      }

      // Mark the delay step done so the resumed pass walks past it.
      await settle('SUCCEEDED', { output: { waitedUntil: resumeAt.toISOString() } })
      return { kind: 'wait', resumeAt }
    }

    case 'approval': {
      if (dryRun) {
        await settle('SUCCEEDED', { output: { wouldAwaitApproval: true } })
        return { kind: 'continue', branch: 'approved' }
      }

      if (step.approvalDecision === 'APPROVED') {
        await settle('SUCCEEDED', { output: { decision: 'APPROVED' } })
        return { kind: 'continue', branch: 'approved' }
      }

      if (step.approvalDecision === 'REJECTED') {
        await settle('SUCCEEDED', { output: { decision: 'REJECTED' } })
        return { kind: 'continue', branch: 'rejected' }
      }

      // Nobody decided before the deadline. A timeout is an outcome, not a
      // failure: the graph says what to do about it, and if it says nothing the
      // run ends here rather than waiting forever.
      if (step.approvalDeadline && step.approvalDeadline <= new Date()) {
        await settle('SUCCEEDED', { output: { decision: 'TIMEOUT' } })
        const timeoutPaths = outgoing(graph, node.id, 'timeout')
        return timeoutPaths.length > 0 ? { kind: 'continue', branch: 'timeout' } : { kind: 'stop' }
      }

      const deadline =
        step.approvalDeadline ?? new Date(Date.now() + node.config.timeoutHours * 3_600_000)
      await settle('WAITING', { approvalDeadline: deadline })
      return { kind: 'wait', resumeAt: deadline }
    }

    case 'action': {
      const definition = getAction(node.action)
      if (!definition) {
        await settle('FAILED', { error: `Unknown action "${node.action}".` })
        return { kind: 'fail', error: `Unknown action "${node.action}".` }
      }

      // Re-checked at run time, not only at publish: an owner may have lost the
      // permission since the workflow was published.
      for (const permission of definition.requiredPermissions) {
        if (!ctx.can(permission)) {
          const message = `The workflow owner no longer holds "${permission}".`
          await settle('FAILED', { error: message })
          return { kind: 'fail', error: message }
        }
      }

      if (!definition.idempotent && step.attempts > 1 && !dryRun) {
        // A non-idempotent action that already ran once is not run again: better
        // an incomplete run than a duplicate email.
        const message = 'Not retried: this action is not safe to repeat.'
        await settle('SKIPPED', { error: message })
        return { kind: 'stop' }
      }

      const config = definition.configSchema.safeParse(node.config)
      if (!config.success) {
        const message = 'The action configuration is not valid.'
        await settle('FAILED', { error: message })
        return { kind: 'fail', error: message }
      }

      try {
        const output = await definition.execute({ ctx, runId, data, dryRun }, config.data as never)

        if (output && typeof output === 'object') Object.assign(data, output)
        await settle('SUCCEEDED', { output: (output ?? {}) as never, input: node.config as never })
        return { kind: 'continue' }
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 400) : 'Action failed.'
        await settle('FAILED', { error: message })
        return { kind: 'fail', error: message }
      }
    }
  }

  void graph
  return { kind: 'continue' }
}

async function finish(
  runId: string,
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
  steps: number,
  error?: string,
): Promise<RunOutcome> {
  await getSystemDb().workflowRun.update({
    where: { id: runId },
    data: { status, finishedAt: new Date(), error: error ?? null },
  })

  return { runId, status, steps, ...(error === undefined ? {} : { error }) }
}

/**
 * Build the context actions run under.
 *
 * Derived from the workflow OWNER, never from whoever caused the triggering
 * event: an automation that ran with the rights of whoever happened to touch a
 * record would be a privilege escalation with a friendly UI.
 */
export async function buildOwnerContext(
  organizationId: string,
  ownerMembershipId: string,
): Promise<Ctx | null> {
  const db = getSystemDb()

  const membership = await db.membership.findFirst({
    where: { id: ownerMembershipId, organizationId, status: 'ACTIVE' },
    select: {
      id: true,
      userId: true,
      user: { select: { id: true, name: true, email: true, emailVerifiedAt: true } },
      organization: {
        select: {
          id: true,
          slug: true,
          name: true,
          logoUrl: true,
          timezone: true,
          currency: true,
          createdById: true,
        },
      },
    },
  })

  if (!membership) return null

  const isOwner = membership.organization.createdById === membership.userId
  const { permissions, roles } = await loadPermissions({
    membershipId: membership.id,
    organizationId,
    isOwner,
  })

  return Object.freeze({
    userId: membership.userId,
    sessionId: 'workflow',
    orgId: organizationId,
    orgSlug: membership.organization.slug,
    membershipId: membership.id,
    isOwner,
    user: {
      id: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      emailVerifiedAt: membership.user.emailVerifiedAt,
    },
    org: {
      id: membership.organization.id,
      slug: membership.organization.slug,
      name: membership.organization.name,
      logoUrl: membership.organization.logoUrl,
      timezone: membership.organization.timezone,
      currency: membership.organization.currency,
    },
    roles,
    permissions,
    can: (permission: Permission) => can(permissions, permission),
    canAny: (list: readonly Permission[]) => canAny(permissions, list),
    require: (permission: Permission) => requirePermission(permissions, permission),
    requireAny: (list: readonly Permission[]) => requireAny(permissions, list),
    scope: (any: Permission, own: Permission) => resolveScope(permissions, any, own),
    granted: (list: readonly Permission[]) => grantedFrom(permissions, list),
    db: getDb(organizationId),
  })
}
