import type { Ctx } from '@/kernel/tenancy/ctx'

/** Agent persistence. Everything here is org-scoped through `ctx.db`. */

/* -------------------------------- config ---------------------------------- */

export async function listConfigs(ctx: Ctx) {
  return ctx.db.aIAgentConfig.findMany({
    select: {
      id: true,
      agentKey: true,
      enabled: true,
      autonomy: true,
      ownerMembershipId: true,
      extraInstructions: true,
      updatedAt: true,
      owner: { select: { id: true, user: { select: { name: true } } } },
    },
  })
}

export async function findConfig(ctx: Ctx, agentKey: string) {
  return ctx.db.aIAgentConfig.findFirst({
    where: { agentKey },
    select: {
      id: true,
      agentKey: true,
      enabled: true,
      autonomy: true,
      ownerMembershipId: true,
      extraInstructions: true,
    },
  })
}

export async function upsertConfig(
  ctx: Ctx,
  input: {
    agentKey: string
    enabled: boolean
    autonomy: 'SUGGEST' | 'AUTONOMOUS'
    ownerMembershipId: string | null
    extraInstructions: string | null
  },
) {
  return ctx.db.aIAgentConfig.upsert({
    where: { organizationId_agentKey: { organizationId: ctx.orgId, agentKey: input.agentKey } },
    create: {
      organizationId: ctx.orgId,
      agentKey: input.agentKey,
      enabled: input.enabled,
      autonomy: input.autonomy,
      ownerMembershipId: input.ownerMembershipId,
      extraInstructions: input.extraInstructions,
    },
    update: {
      enabled: input.enabled,
      autonomy: input.autonomy,
      ownerMembershipId: input.ownerMembershipId,
      extraInstructions: input.extraInstructions,
    },
    select: { id: true },
  })
}

/* ---------------------------------- runs ----------------------------------- */

export async function createRun(
  ctx: Ctx,
  input: {
    agentKey: string
    trigger: string
    input: unknown
    actingMembershipId: string
    startedById: string
  },
) {
  return ctx.db.aIAgentRun.create({
    data: {
      organizationId: ctx.orgId,
      agentKey: input.agentKey,
      trigger: input.trigger,
      input: input.input as never,
      actingMembershipId: input.actingMembershipId,
      startedById: input.startedById,
      status: 'RUNNING',
    },
    select: { id: true },
  })
}

export async function addStep(
  ctx: Ctx,
  input: {
    runId: string
    position: number
    kind: string
    toolName?: string | null
    input?: unknown
    output?: unknown
    error?: string | null
    durationMs?: number | null
  },
) {
  return ctx.db.aIAgentStep.create({
    data: {
      organizationId: ctx.orgId,
      runId: input.runId,
      position: input.position,
      kind: input.kind,
      toolName: input.toolName ?? null,
      input: (input.input ?? null) as never,
      output: (input.output ?? null) as never,
      error: input.error ?? null,
      durationMs: input.durationMs ?? null,
    },
    select: { id: true },
  })
}

export async function finishRun(
  ctx: Ctx,
  runId: string,
  input: {
    status: 'COMPLETED' | 'AWAITING_CONFIRMATION' | 'FAILED'
    summary?: string
    error?: string
    usage: { promptTokens: number; completionTokens: number; costMicros: number }
  },
) {
  await ctx.db.aIAgentRun.updateMany({
    where: { id: runId },
    data: {
      status: input.status,
      summary: input.summary ?? null,
      error: input.error ?? null,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      costMicros: input.usage.costMicros,
      finishedAt: input.status === 'AWAITING_CONFIRMATION' ? null : new Date(),
    },
  })
}

export async function listRuns(ctx: Ctx, agentKey?: string, limit = 25) {
  return ctx.db.aIAgentRun.findMany({
    where: agentKey ? { agentKey } : {},
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      agentKey: true,
      status: true,
      trigger: true,
      summary: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      _count: { select: { steps: true, proposals: true } },
    },
  })
}

export async function findRun(ctx: Ctx, id: string) {
  return ctx.db.aIAgentRun.findFirst({
    where: { id },
    select: {
      id: true,
      agentKey: true,
      status: true,
      trigger: true,
      input: true,
      summary: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      promptTokens: true,
      completionTokens: true,
      steps: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          kind: true,
          toolName: true,
          input: true,
          output: true,
          error: true,
          durationMs: true,
        },
      },
      proposals: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          toolName: true,
          summary: true,
          status: true,
          outcome: true,
          decidedAt: true,
        },
      },
    },
  })
}

/* -------------------------------- proposals -------------------------------- */

export async function createProposal(
  ctx: Ctx,
  input: {
    runId: string
    toolName: string
    args: Record<string, unknown>
    summary: string
    idempotencyKey: string
  },
) {
  return ctx.db.aIProposal.upsert({
    where: {
      organizationId_idempotencyKey: {
        organizationId: ctx.orgId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    create: {
      organizationId: ctx.orgId,
      runId: input.runId,
      toolName: input.toolName,
      args: input.args as never,
      summary: input.summary,
      idempotencyKey: input.idempotencyKey,
      status: 'PENDING',
    },
    // An identical proposal within one run is the same proposal, not a second.
    update: {},
    select: { id: true },
  })
}

export async function findProposal(ctx: Ctx, id: string) {
  const proposal = await ctx.db.aIProposal.findFirst({
    where: { id },
    select: { id: true, runId: true, toolName: true, args: true, status: true },
  })

  if (!proposal) return null
  return { ...proposal, args: (proposal.args ?? {}) as Record<string, unknown> }
}

/**
 * Claim a pending proposal.
 *
 * A conditional update rather than a read-then-write: two people pressing
 * Accept at the same moment must not both execute it, and the database is the
 * only place that can settle that race.
 */
export async function claimProposal(ctx: Ctx, id: string): Promise<number> {
  const result = await ctx.db.aIProposal.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'ACCEPTED', decidedByMembershipId: ctx.membershipId, decidedAt: new Date() },
  })
  return result.count
}

export async function settleProposal(
  ctx: Ctx,
  id: string,
  input: { status: 'ACCEPTED' | 'REJECTED' | 'FAILED'; outcome: unknown },
) {
  await ctx.db.aIProposal.updateMany({
    where: { id },
    data: {
      status: input.status,
      outcome: (input.outcome ?? null) as never,
      decidedByMembershipId: ctx.membershipId,
      decidedAt: new Date(),
    },
  })
}

export async function listPendingProposals(ctx: Ctx, limit = 25) {
  return ctx.db.aIProposal.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      toolName: true,
      summary: true,
      createdAt: true,
      run: { select: { id: true, agentKey: true } },
    },
  })
}

/** Close a run once nothing is left waiting on a person. */
export async function settleRunIfDone(ctx: Ctx, runId: string): Promise<void> {
  const pending = await ctx.db.aIProposal.count({ where: { runId, status: 'PENDING' } })
  if (pending > 0) return

  await ctx.db.aIAgentRun.updateMany({
    where: { id: runId, status: 'AWAITING_CONFIRMATION' },
    data: { status: 'COMPLETED', finishedAt: new Date() },
  })
}

/* --------------------------------- memory ---------------------------------- */

/**
 * Store a fact an agent should remember.
 *
 * Read-then-write rather than an upsert: the unique key includes a NULLABLE
 * `membershipId` for organization-wide memories, and Prisma's compound unique
 * lookup cannot take a null. The race this loses to is two writes of the same
 * key, where last-writer-wins is the correct outcome anyway.
 */
export async function rememberFact(
  ctx: Ctx,
  input: { agentKey: string; key: string; value: string; shared?: boolean },
) {
  const membershipId = input.shared ? null : ctx.membershipId

  const existing = await ctx.db.aIMemory.findFirst({
    where: { agentKey: input.agentKey, key: input.key, membershipId },
    select: { id: true },
  })

  if (existing) {
    await ctx.db.aIMemory.updateMany({ where: { id: existing.id }, data: { value: input.value } })
    return existing
  }

  return ctx.db.aIMemory.create({
    data: {
      organizationId: ctx.orgId,
      agentKey: input.agentKey,
      membershipId,
      key: input.key,
      value: input.value,
    },
    select: { id: true },
  })
}

export async function recallFacts(ctx: Ctx, agentKey: string, limit = 20) {
  return ctx.db.aIMemory.findMany({
    where: {
      agentKey,
      OR: [{ membershipId: ctx.membershipId }, { membershipId: null }],
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { key: true, value: true, updatedAt: true },
  })
}
