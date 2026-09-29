import { getAiConfig } from '@/kernel/config/env'
import { conflict, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getProvider, modelFor } from '@/lib/ai/router'
import { redactText } from '@/lib/ai/redact'
import type { GenerateRequest, GenerateResult, StreamPart } from '@/lib/ai/types'

import * as repository from './repository'

/**
 * The gateway every model call goes through.
 *
 * Nothing calls a provider directly. This is where the cross-cutting concerns
 * live, in the order they have to happen:
 *
 *   budget check → redaction → timeout → provider → metering → audit row
 *
 * The budget check is BEFORE the call, not after. A ceiling discovered on an
 * invoice is not a ceiling. And the audit row is written whether the call
 * succeeded, failed or was refused — a refusal is the most interesting case and
 * the one a missing-row design would lose.
 */

export class AiUnavailableError extends Error {
  readonly code = 'AI_UNAVAILABLE'
  constructor(message = 'AI generation is not configured on this deployment.') {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

export interface GatewayOptions {
  purpose: string
  conversationId?: string | undefined
}

/** True when a provider is configured. Used by the UI to say so honestly. */
export { isAiConfigured } from '@/lib/ai/router'

export async function generate(
  ctx: Ctx,
  request: Omit<GenerateRequest, 'purpose'>,
  options: GatewayOptions,
): Promise<GenerateResult> {
  ctx.require('ai.use')

  const provider = getProvider()
  if (!provider) {
    await recordRefusal(ctx, options, 'No AI provider is configured.')
    throw new AiUnavailableError()
  }

  const budget = await checkBudget(ctx)
  if (!budget.withinBudget) {
    await recordRefusal(ctx, options, 'Monthly AI budget exhausted.', 'BUDGET_EXCEEDED')
    throw conflict(
      `This organization has reached its monthly AI budget (${formatUsd(budget.limitMicros)}). It resets at the start of next month.`,
    )
  }

  const model = modelFor(options.purpose)
  const started = Date.now()

  const prepared: GenerateRequest = {
    ...request,
    purpose: options.purpose,
    // Redaction is applied here rather than at call sites so it cannot be
    // forgotten by one of them.
    system: redactText(request.system),
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === 'text' ? { ...part, text: redactText(part.text) } : part,
      ),
    })),
    timeoutMs: request.timeoutMs ?? 60_000,
  }

  try {
    const result = await provider.generate(prepared, model)
    const costMicros = provider.estimateCostMicros(result.usage, result.model)

    await repository.recordExecution({
      organizationId: ctx.orgId,
      kind: 'GENERATE',
      status: 'SUCCEEDED',
      purpose: options.purpose,
      model: result.model,
      provider: provider.id,
      actorId: ctx.userId,
      conversationId: options.conversationId ?? null,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      costMicros,
      durationMs: Date.now() - started,
    })

    await repository.addUsage(ctx.orgId, {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      costMicros,
    })

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : 'The model call failed.'

    await repository.recordExecution({
      organizationId: ctx.orgId,
      kind: 'GENERATE',
      status: 'FAILED',
      purpose: options.purpose,
      model,
      provider: provider.id,
      actorId: ctx.userId,
      conversationId: options.conversationId ?? null,
      promptTokens: 0,
      completionTokens: 0,
      costMicros: 0,
      durationMs: Date.now() - started,
      error: message,
    })

    throw error
  }
}

/**
 * Stream a generation.
 *
 * Metering happens on the `finish` part, which is why the stream is wrapped
 * rather than returned directly: a caller that abandoned the iterator halfway
 * would otherwise skip the accounting entirely.
 */
export async function* stream(
  ctx: Ctx,
  request: Omit<GenerateRequest, 'purpose'>,
  options: GatewayOptions,
): AsyncIterable<StreamPart> {
  ctx.require('ai.use')

  const provider = getProvider()
  if (!provider) {
    await recordRefusal(ctx, options, 'No AI provider is configured.')
    throw new AiUnavailableError()
  }

  const budget = await checkBudget(ctx)
  if (!budget.withinBudget) {
    await recordRefusal(ctx, options, 'Monthly AI budget exhausted.', 'BUDGET_EXCEEDED')
    throw conflict('This organization has reached its monthly AI budget.')
  }

  const model = modelFor(options.purpose)
  const started = Date.now()

  const prepared: GenerateRequest = {
    ...request,
    purpose: options.purpose,
    system: redactText(request.system),
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === 'text' ? { ...part, text: redactText(part.text) } : part,
      ),
    })),
    timeoutMs: request.timeoutMs ?? 120_000,
  }

  let metered = false

  try {
    for await (const part of provider.stream(prepared, model)) {
      if (part.type === 'finish') {
        metered = true
        const costMicros = provider.estimateCostMicros(part.usage, part.model)

        await repository.recordExecution({
          organizationId: ctx.orgId,
          kind: 'STREAM',
          status: 'SUCCEEDED',
          purpose: options.purpose,
          model: part.model,
          provider: provider.id,
          actorId: ctx.userId,
          conversationId: options.conversationId ?? null,
          promptTokens: part.usage.promptTokens,
          completionTokens: part.usage.completionTokens,
          costMicros,
          durationMs: Date.now() - started,
        })

        await repository.addUsage(ctx.orgId, {
          promptTokens: part.usage.promptTokens,
          completionTokens: part.usage.completionTokens,
          costMicros,
        })
      }

      yield part
    }
  } finally {
    if (!metered) {
      // The stream ended without a finish part: the caller stopped reading, or
      // the connection dropped. The call still happened, so it is still
      // recorded — with zero tokens, because the true count is unknown and
      // guessing would corrupt the ledger.
      await repository.recordExecution({
        organizationId: ctx.orgId,
        kind: 'STREAM',
        status: 'FAILED',
        purpose: options.purpose,
        model,
        provider: provider.id,
        actorId: ctx.userId,
        conversationId: options.conversationId ?? null,
        promptTokens: 0,
        completionTokens: 0,
        costMicros: 0,
        durationMs: Date.now() - started,
        error: 'The stream ended before completion.',
      })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Budget                                                                      */
/* -------------------------------------------------------------------------- */

export interface BudgetStatus {
  withinBudget: boolean
  usedMicros: number
  limitMicros: number
  remainingMicros: number
  periodStart: Date
}

export async function checkBudget(ctx: Ctx): Promise<BudgetStatus> {
  const limitMicros = getAiConfig().monthlyBudgetMicros
  const periodStart = currentPeriodStart()
  const usage = await repository.usageForPeriod(ctx.orgId, periodStart)
  const usedMicros = usage?.costMicros ?? 0

  return {
    withinBudget: usedMicros < limitMicros,
    usedMicros,
    limitMicros,
    remainingMicros: Math.max(0, limitMicros - usedMicros),
    periodStart,
  }
}

export function currentPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Micros of USD as a readable amount. Integer arithmetic, then formatted. */
export function formatUsd(micros: number): string {
  const cents = Math.round(micros / 10_000)
  return `$${(cents / 100).toFixed(2)}`
}

async function recordRefusal(
  ctx: Ctx,
  options: GatewayOptions,
  reason: string,
  status: 'REFUSED' | 'BUDGET_EXCEEDED' = 'REFUSED',
): Promise<void> {
  await repository.recordExecution({
    organizationId: ctx.orgId,
    kind: 'GENERATE',
    status,
    purpose: options.purpose,
    model: null,
    provider: null,
    actorId: ctx.userId,
    conversationId: options.conversationId ?? null,
    promptTokens: 0,
    completionTokens: 0,
    costMicros: 0,
    durationMs: 0,
    error: reason,
  })
}

/** Guard for a caller that must not proceed without a provider. */
export function requireProvider(): void {
  if (!getProvider()) throw validationError('AI generation is not configured on this deployment.')
}
