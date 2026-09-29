import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

/**
 * AI persistence.
 *
 * `recordExecution` and `addUsage` take an organization id rather than a `Ctx`
 * because they are also called from places with no request context — the
 * insight sweep, a workflow action. Everything a USER reads goes through the
 * org-scoped client as usual.
 */

/* ------------------------------- executions -------------------------------- */

export async function recordExecution(input: {
  organizationId: string
  kind: 'GENERATE' | 'STREAM' | 'EMBED' | 'TOOL'
  status: 'SUCCEEDED' | 'FAILED' | 'REFUSED' | 'BUDGET_EXCEEDED'
  purpose: string
  model: string | null
  provider: string | null
  toolName?: string | null
  actorId: string | null
  actorType?: string
  conversationId?: string | null
  promptTokens: number
  completionTokens: number
  costMicros: number
  durationMs?: number | null
  error?: string | null
}): Promise<void> {
  try {
    await getSystemDb().aIExecution.create({
      data: {
        organizationId: input.organizationId,
        kind: input.kind,
        status: input.status,
        purpose: input.purpose,
        model: input.model,
        provider: input.provider,
        toolName: input.toolName ?? null,
        actorId: input.actorId,
        actorType: input.actorType ?? 'USER',
        conversationId: input.conversationId ?? null,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        costMicros: input.costMicros,
        durationMs: input.durationMs ?? null,
        error: input.error ?? null,
      },
    })
  } catch (error) {
    // Losing an audit row must never fail the thing being audited. It is logged
    // loudly instead, which is the same trade the audit writer makes.
    console.error('[ai] failed to record execution', { purpose: input.purpose, error })
  }
}

export async function listExecutions(ctx: Ctx, limit = 50) {
  return ctx.db.aIExecution.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      kind: true,
      status: true,
      purpose: true,
      model: true,
      toolName: true,
      promptTokens: true,
      completionTokens: true,
      costMicros: true,
      durationMs: true,
      error: true,
      createdAt: true,
    },
  })
}

/* ---------------------------------- usage ---------------------------------- */

export async function usageForPeriod(organizationId: string, periodStart: Date) {
  return getSystemDb().aIUsageCounter.findUnique({
    where: { organizationId_periodStart: { organizationId, periodStart } },
    select: { promptTokens: true, completionTokens: true, costMicros: true, calls: true },
  })
}

/**
 * Add to the running total.
 *
 * An upsert with increments, so two concurrent calls cannot lose one another's
 * usage the way a read-modify-write would.
 */
export async function addUsage(
  organizationId: string,
  usage: { promptTokens: number; completionTokens: number; costMicros: number },
  periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
): Promise<void> {
  await getSystemDb().aIUsageCounter.upsert({
    where: { organizationId_periodStart: { organizationId, periodStart } },
    create: {
      organizationId,
      periodStart,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costMicros: usage.costMicros,
      calls: 1,
    },
    update: {
      promptTokens: { increment: usage.promptTokens },
      completionTokens: { increment: usage.completionTokens },
      costMicros: { increment: usage.costMicros },
      calls: { increment: 1 },
    },
  })
}

export async function usageHistory(ctx: Ctx, months = 6) {
  return ctx.db.aIUsageCounter.findMany({
    orderBy: { periodStart: 'desc' },
    take: months,
    select: {
      periodStart: true,
      promptTokens: true,
      completionTokens: true,
      costMicros: true,
      calls: true,
    },
  })
}

/* -------------------------------- insights --------------------------------- */

export async function listInsights(ctx: Ctx, { includeDismissed = false } = {}) {
  return ctx.db.aIInsight.findMany({
    where: includeDismissed ? {} : { dismissedAt: null },
    orderBy: [{ severity: 'desc' }, { computedAt: 'desc' }],
    take: 50,
    select: {
      id: true,
      kind: true,
      severity: true,
      title: true,
      detail: true,
      evidence: true,
      requiredPermission: true,
      dismissedAt: true,
      computedAt: true,
    },
  })
}

export async function upsertInsight(
  organizationId: string,
  input: {
    dedupeKey: string
    kind: string
    severity: 'INFO' | 'WARNING' | 'CRITICAL'
    title: string
    detail: string
    evidence: unknown
    requiredPermission: string | null
  },
): Promise<void> {
  await getSystemDb().aIInsight.upsert({
    where: { organizationId_dedupeKey: { organizationId, dedupeKey: input.dedupeKey } },
    create: {
      organizationId,
      dedupeKey: input.dedupeKey,
      kind: input.kind as never,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      evidence: input.evidence as never,
      requiredPermission: input.requiredPermission,
    },
    update: {
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      evidence: input.evidence as never,
      computedAt: new Date(),
      // A recomputed insight that is still true is raised again: "I dealt with
      // it" should not silence a problem that came back.
      dismissedAt: null,
      dismissedByMembershipId: null,
    },
  })
}

/** Remove insights of a kind that no longer hold, so nothing stale is shown. */
export async function clearInsights(
  organizationId: string,
  kind: string,
  keepKeys: string[],
): Promise<void> {
  await getSystemDb().aIInsight.deleteMany({
    where: {
      organizationId,
      kind: kind as never,
      ...(keepKeys.length > 0 ? { dedupeKey: { notIn: keepKeys } } : {}),
    },
  })
}

export async function dismissInsight(ctx: Ctx, id: string): Promise<number> {
  const result = await ctx.db.aIInsight.updateMany({
    where: { id, dismissedAt: null },
    data: { dismissedAt: new Date(), dismissedByMembershipId: ctx.membershipId },
  })
  return result.count
}

/* ------------------------------ conversations ------------------------------ */

export async function listConversations(ctx: Ctx, limit = 20) {
  return ctx.db.aIConversation.findMany({
    where: { membershipId: ctx.membershipId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, title: true, updatedAt: true, _count: { select: { messages: true } } },
  })
}

export async function findConversation(ctx: Ctx, id: string) {
  return ctx.db.aIConversation.findFirst({
    // Keyed by membership as well as id: a conversation is private to the
    // person who had it, and no permission grants reading someone else's.
    where: { id, membershipId: ctx.membershipId, deletedAt: null },
    select: {
      id: true,
      title: true,
      entityType: true,
      entityId: true,
      createdAt: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          toolCalls: true,
          citations: true,
          createdAt: true,
        },
      },
    },
  })
}

export async function createConversation(ctx: Ctx, title: string) {
  return ctx.db.aIConversation.create({
    data: { organizationId: ctx.orgId, membershipId: ctx.membershipId, title },
    select: { id: true },
  })
}

export async function appendMessage(
  ctx: Ctx,
  input: {
    conversationId: string
    role: string
    content: string
    toolCalls?: unknown
    citations?: unknown
    promptTokens?: number
    completionTokens?: number
  },
) {
  const message = await ctx.db.aIMessage.create({
    data: {
      organizationId: ctx.orgId,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      toolCalls: (input.toolCalls ?? null) as never,
      citations: (input.citations ?? null) as never,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
    },
    select: { id: true },
  })

  await ctx.db.aIConversation.updateMany({
    where: { id: input.conversationId },
    data: { updatedAt: new Date() },
  })

  return message
}

export async function deleteConversation(ctx: Ctx, id: string): Promise<number> {
  const result = await ctx.db.aIConversation.updateMany({
    where: { id, membershipId: ctx.membershipId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  return result.count
}
