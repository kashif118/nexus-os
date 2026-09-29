import { writeAuditLog } from '@/kernel/audit/write'
import { notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { isAiConfigured } from '@/lib/ai/router'
import type { Message, ToolCallPart } from '@/lib/ai/types'
import { messageText, userMessage } from '@/lib/ai/types'

import './tools/read-tools'

import * as gateway from './gateway'
import { refreshInsights } from './insights'
import { buildSystemPrompt, titleFromFirstMessage } from './prompt'
import * as repository from './repository'
import { invokeTool, toolSpecsFor } from './tools/registry'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * The assistant.
 *
 * The loop is: ask the model → it may call tools → run them under the CALLER's
 * permissions → feed the results back → repeat, up to a hard step limit. The
 * limit is not a performance guard; it is what stops a model that has decided
 * to keep searching from spending an organization's budget on one question.
 *
 * Nothing here has a privileged path to data. Every fact in an answer came back
 * through a tool, which called a service, which checked authorization against
 * the same `Ctx` a page would have used.
 */

const MAX_TOOL_ROUNDS = 5

export const aiStatus = () => ({ configured: isAiConfigured() })

export async function listConversations(ctx: Ctx) {
  ctx.require('ai.use')
  return repository.listConversations(ctx)
}

export async function getConversation(ctx: Ctx, id: string) {
  ctx.require('ai.use')

  const conversation = await repository.findConversation(ctx, id)
  if (!conversation) throw notFound('That conversation is not available.')
  return conversation
}

export async function deleteConversation(ctx: Ctx, id: string): Promise<void> {
  ctx.require('ai.use')
  const removed = await repository.deleteConversation(ctx, id)
  if (removed === 0) throw notFound('That conversation is not available.')
}

export interface AskResult {
  conversationId: string
  answer: string
  toolCalls: Array<{ name: string; ok: boolean }>
  usage: { promptTokens: number; completionTokens: number }
}

/**
 * Ask a question and get a complete answer.
 *
 * Not streamed: streaming belongs in a route handler, and the same loop would
 * have to exist twice. This is the version the tests and the non-streaming
 * surfaces use; the streaming route reuses it for tool rounds and streams only
 * the final turn.
 */
export async function ask(
  ctx: Ctx,
  input: { conversationId?: string | undefined; question: string },
  meta: RequestMeta,
): Promise<AskResult> {
  ctx.require('ai.use')

  const question = input.question.trim()
  if (question.length === 0) throw validationError('Ask a question.')
  if (question.length > 8_000) throw validationError('That question is too long.')

  const conversationId =
    input.conversationId ??
    (await repository.createConversation(ctx, titleFromFirstMessage(question))).id

  // Re-fetched even when the id was supplied: a conversation id from a form is
  // untrusted, and `findConversation` is keyed by membership.
  const conversation = await repository.findConversation(ctx, conversationId)
  if (!conversation) throw notFound('That conversation is not available.')

  await repository.appendMessage(ctx, {
    conversationId,
    role: 'user',
    content: question,
  })

  const history: Message[] = conversation.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    // A rolling window: the last twenty turns. Older context is dropped rather
    // than summarised, because a summary is another model call and this build
    // does not spend one on it.
    .slice(-20)
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: [{ type: 'text' as const, text: message.content }],
    }))

  const messages: Message[] = [...history, userMessage(question)]
  const system = buildSystemPrompt(ctx, { allowWrites: false })
  const tools = toolSpecsFor(ctx)

  const attempted: Array<{ name: string; ok: boolean }> = []
  const usage = { promptTokens: 0, completionTokens: 0 }

  let answer = ''

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const result = await gateway.generate(
      ctx,
      { system, messages, tools, maxTokens: 2_000 },
      { purpose: 'assistant', conversationId },
    )

    usage.promptTokens += result.usage.promptTokens
    usage.completionTokens += result.usage.completionTokens

    if (result.toolCalls.length === 0) {
      answer = result.text
      break
    }

    if (round === MAX_TOOL_ROUNDS) {
      // Out of rounds with the model still working. Saying so is better than
      // presenting a partial answer as a complete one.
      answer =
        result.text ||
        'I ran out of steps while looking that up. Try asking for something more specific.'
      break
    }

    messages.push({
      role: 'assistant',
      content: [
        ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
        ...result.toolCalls,
      ],
    })

    const results = await Promise.all(
      result.toolCalls.map(async (call: ToolCallPart) => {
        const outcome = await invokeTool(ctx, call.name, call.arguments)
        attempted.push({ name: call.name, ok: outcome.ok })

        await repository.recordExecution({
          organizationId: ctx.orgId,
          kind: 'TOOL',
          status: outcome.ok ? 'SUCCEEDED' : 'REFUSED',
          purpose: 'assistant',
          model: null,
          provider: null,
          toolName: call.name,
          actorId: ctx.userId,
          conversationId,
          promptTokens: 0,
          completionTokens: 0,
          costMicros: 0,
        })

        return {
          type: 'tool_result' as const,
          toolCallId: call.id,
          content: outcome.content,
          ...(outcome.ok ? {} : { isError: true }),
        }
      }),
    )

    messages.push({ role: 'tool', content: results })
  }

  await repository.appendMessage(ctx, {
    conversationId,
    role: 'assistant',
    content: answer,
    toolCalls: attempted,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  })

  await writeAuditLog({
    action: 'ai.assistant.asked',
    entityType: 'AIConversation',
    entityId: conversationId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { tools: attempted.map((entry) => entry.name).join(',') },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { conversationId, answer, toolCalls: attempted, usage: { ...usage } }
}

/* -------------------------------- insights --------------------------------- */

/**
 * Insights the caller is allowed to see.
 *
 * Filtered here rather than in the query because the rule is a permission
 * check, and permission checks belong in the service. An insight about overdue
 * invoices names an unpaid amount; showing it to someone who cannot see
 * invoices would leak through the summary.
 */
export async function listInsights(ctx: Ctx) {
  const insights = await repository.listInsights(ctx)

  return insights.filter(
    (insight) =>
      insight.requiredPermission === null || ctx.can(insight.requiredPermission as never),
  )
}

export async function refresh(ctx: Ctx): Promise<{ written: number }> {
  return refreshInsights(ctx)
}

export async function dismissInsight(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  const dismissed = await repository.dismissInsight(ctx, id)
  if (dismissed === 0) throw notFound('That insight is not available.')

  await writeAuditLog({
    action: 'ai.insight.dismissed',
    entityType: 'AIInsight',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* ---------------------------------- usage ---------------------------------- */

export async function getUsage(ctx: Ctx) {
  ctx.require('ai.use')

  const [budget, history, executions] = await Promise.all([
    gateway.checkBudget(ctx),
    repository.usageHistory(ctx),
    repository.listExecutions(ctx, 25),
  ])

  return { budget, history, executions, configured: isAiConfigured() }
}

/** Exported for the streaming route, which needs the same assembly. */
export const assistantContext = (ctx: Ctx) => ({
  system: buildSystemPrompt(ctx, { allowWrites: false }),
  tools: toolSpecsFor(ctx),
})

export { messageText }
