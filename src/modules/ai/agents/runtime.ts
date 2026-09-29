import { createHash } from 'node:crypto'

import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, forbidden, notFound } from '@/kernel/errors'
import { buildMembershipCtx, type Ctx } from '@/kernel/tenancy/ctx'
import type { Message, ToolCallPart, ToolSpec } from '@/lib/ai/types'
import { userMessage } from '@/lib/ai/types'

import '../tools/read-tools'
import '../tools/write-tools'

import * as gateway from '../gateway'
import { buildSystemPrompt } from '../prompt'
import { getTool, invokeTool, listTools } from '../tools/registry'
import { getAgent, type AgentDefinition } from './registry'
import * as repository from './repository'

/**
 * The agent runtime.
 *
 * The loop is the same shape as the assistant's, with three differences that
 * are the whole point of an agent:
 *
 * 1. **A narrower tool list.** An agent sees only the tools its definition
 *    names, intersected with what its owner may do. Two ceilings, and the lower
 *    one wins.
 * 2. **Writes become proposals.** A write tool called by a SUGGEST agent is not
 *    executed. It is recorded as a proposal for a person to accept, and the
 *    model is told that is what happened — so it can carry on reasoning without
 *    believing the change is done.
 * 3. **Every step is a row.** The transparency panel shows what it looked at,
 *    what it found and what it decided, which is what makes an agent something
 *    a person can supervise rather than something they have to trust.
 */

const MAX_ROUNDS = 6

export interface AgentRunResult {
  runId: string
  status: 'COMPLETED' | 'AWAITING_CONFIRMATION' | 'FAILED'
  summary: string
  proposals: Array<{ id: string; toolName: string; summary: string }>
}

export async function runAgent(
  ctx: Ctx,
  input: { agentKey: string; question?: string | undefined; trigger?: string },
): Promise<AgentRunResult> {
  ctx.require('ai.use')

  const definition = getAgent(input.agentKey)
  if (!definition) throw notFound('That agent is not available.')

  const config = await repository.findConfig(ctx, input.agentKey)
  if (!config?.enabled) throw conflict('That agent is switched off for this organization.')
  if (!config.ownerMembershipId) {
    throw conflict('That agent has no owner, so it has no permissions to act with.')
  }

  ctx.require(definition.permission)

  // The run acts as the agent's OWNER, not as whoever pressed the button. An
  // agent that borrowed the permissions of whoever triggered it would be a
  // privilege escalation with a friendly button.
  const actingCtx = await buildMembershipCtx(ctx.orgId, config.ownerMembershipId)
  if (!actingCtx) throw conflict('The agent owner is no longer an active member.')

  for (const permission of definition.requiredPermissions) {
    if (!actingCtx.can(permission)) {
      throw forbidden(`The agent owner no longer holds "${permission}", which this agent needs.`)
    }
  }

  const autonomous = config.autonomy === 'AUTONOMOUS'

  const run = await repository.createRun(ctx, {
    agentKey: definition.key,
    trigger: input.trigger ?? 'manual',
    input: { question: input.question ?? null },
    actingMembershipId: config.ownerMembershipId,
    startedById: ctx.userId,
  })

  const tools = toolsFor(definition, actingCtx)
  const system = [
    buildSystemPrompt(actingCtx, { allowWrites: autonomous }),
    '',
    `You are the ${definition.name}.`,
    definition.instructions,
    ...(config.extraInstructions
      ? ['', 'Additional instructions from this organization:', config.extraInstructions]
      : []),
    ...(autonomous
      ? []
      : [
          '',
          'Your write tools do not take effect. Calling one records a PROPOSAL that a person will accept or reject. Say what you proposed; never say you have done it.',
        ]),
  ].join('\n')

  const messages: Message[] = [
    userMessage(
      input.question?.trim() ||
        'Review the current state and report what needs attention. Propose action only where it is warranted.',
    ),
  ]

  const proposals: Array<{ id: string; toolName: string; summary: string }> = []
  const usage = { promptTokens: 0, completionTokens: 0, costMicros: 0 }
  let position = 0
  let summary = ''

  try {
    for (let round = 0; round <= MAX_ROUNDS; round += 1) {
      const result = await gateway.generate(
        actingCtx,
        { system, messages, tools, maxTokens: 2_000 },
        { purpose: 'assistant' },
      )

      usage.promptTokens += result.usage.promptTokens
      usage.completionTokens += result.usage.completionTokens

      if (result.toolCalls.length === 0 || round === MAX_ROUNDS) {
        summary =
          result.text ||
          (round === MAX_ROUNDS ? 'I ran out of steps before finishing.' : 'Nothing to report.')

        position += 1
        await repository.addStep(ctx, {
          runId: run.id,
          position,
          kind: 'answer',
          output: { text: summary },
        })
        break
      }

      messages.push({
        role: 'assistant',
        content: [
          ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
          ...result.toolCalls,
        ],
      })

      const outcomes = await Promise.all(
        result.toolCalls.map(async (call: ToolCallPart) => {
          // Captured into a local. Reading the outer counter after an await
          // would read whatever the sibling call had incremented it to, and two
          // steps would claim the same position.
          const stepPosition = (position += 1)
          const startedAt = Date.now()

          // The allowlist is enforced HERE, not only by what was offered. The
          // model can name any tool it likes; filtering the list it was shown
          // is a hint, and a hint is not a control.
          if (!definition.tools.includes(call.name)) {
            await repository.addStep(ctx, {
              runId: run.id,
              position: stepPosition,
              kind: 'refused',
              toolName: call.name,
              input: call.arguments,
              error: 'Outside this agent’s allowed tools.',
              durationMs: Date.now() - startedAt,
            })

            return {
              type: 'tool_result' as const,
              toolCallId: call.id,
              content: `"${call.name}" is not one of your tools. Use only the tools you were given.`,
              isError: true,
            }
          }

          const definitionForTool = getTool(call.name)
          const isWrite = definitionForTool?.sideEffect !== 'read'

          if (isWrite && !autonomous) {
            const proposal = await recordProposal(ctx, run.id, call)
            proposals.push(proposal)

            await repository.addStep(ctx, {
              runId: run.id,
              position: stepPosition,
              kind: 'proposal',
              toolName: call.name,
              input: call.arguments,
              output: { proposalId: proposal.id },
              durationMs: Date.now() - startedAt,
            })

            return {
              type: 'tool_result' as const,
              toolCallId: call.id,
              content:
                'Recorded as a proposal for a person to accept. It has NOT taken effect. Continue, and mention it in your summary.',
            }
          }

          const outcome = await invokeTool(actingCtx, call.name, call.arguments, {
            allowWrites: autonomous,
          })

          await repository.addStep(ctx, {
            runId: run.id,
            position: stepPosition,
            kind: isWrite ? 'write' : 'read',
            toolName: call.name,
            input: call.arguments,
            output: { ok: outcome.ok, content: outcome.content.slice(0, 2_000) },
            error: outcome.ok ? null : outcome.content.slice(0, 300),
            durationMs: Date.now() - startedAt,
          })

          return {
            type: 'tool_result' as const,
            toolCallId: call.id,
            content: outcome.content,
            ...(outcome.ok ? {} : { isError: true }),
          }
        }),
      )

      messages.push({ role: 'tool', content: outcomes })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : 'The agent run failed.'
    await repository.finishRun(ctx, run.id, { status: 'FAILED', error: message, usage })
    throw error
  }

  const status = proposals.length > 0 ? 'AWAITING_CONFIRMATION' : 'COMPLETED'
  await repository.finishRun(ctx, run.id, { status, summary, usage })

  await writeAuditLog({
    action: 'ai.agent.ran',
    entityType: 'AIAgentRun',
    entityId: run.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    actorType: 'AGENT',
    metadata: { agentKey: definition.key, proposals: String(proposals.length) },
  })

  return { runId: run.id, status, summary, proposals }
}

/**
 * The tools an agent may call.
 *
 * The intersection of the agent's allowlist and the owner's permissions. A tool
 * missing from either list is not offered and would be refused if called.
 */
function toolsFor(definition: AgentDefinition, actingCtx: Ctx): ToolSpec[] {
  return listTools()
    .filter((tool) => definition.tools.includes(tool.name))
    .filter((tool) => tool.requiredPermissions.every((permission) => actingCtx.can(permission)))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    }))
}

async function recordProposal(
  ctx: Ctx,
  runId: string,
  call: ToolCallPart,
): Promise<{ id: string; toolName: string; summary: string }> {
  const summary = describeProposal(call)

  // Derived from the run, the tool and the arguments, so an identical proposal
  // within one run cannot be recorded — or later executed — twice.
  const idempotencyKey = createHash('sha256')
    .update(`${runId}:${call.name}:${JSON.stringify(call.arguments)}`)
    .digest('hex')
    .slice(0, 40)

  const proposal = await repository.createProposal(ctx, {
    runId,
    toolName: call.name,
    args: call.arguments,
    summary,
    idempotencyKey,
  })

  return { id: proposal.id, toolName: call.name, summary }
}

/** A one-line description a person can decide on without reading JSON. */
export function describeProposal(call: ToolCallPart): string {
  const args = call.arguments

  const text = (key: string): string => {
    const value = args[key]
    return typeof value === 'string' ? value : ''
  }

  switch (call.name) {
    case 'createTask':
      return `Create a task: "${text('title')}"${args.assigneeMembershipId ? ' (assigned)' : ''}`
    case 'sendNotification':
      return `Notify someone: "${text('title')}"`
    case 'addTaskComment':
      return `Comment on a task: "${text('body').slice(0, 80)}"`
    default:
      return `Call ${call.name}`
  }
}

/* -------------------------------------------------------------------------- */
/* Proposals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Accept a proposal and carry it out.
 *
 * Executed with the ACCEPTING person's context, not the agent owner's: the
 * person taking responsibility is the one whose permissions are used, which is
 * what makes "accept" a meaningful act rather than a rubber stamp on somebody
 * else's authority.
 */
export async function acceptProposal(
  ctx: Ctx,
  proposalId: string,
): Promise<{ ok: boolean; message: string }> {
  ctx.require('ai.use')

  const proposal = await repository.findProposal(ctx, proposalId)
  if (!proposal) throw notFound('That proposal is not available.')
  if (proposal.status !== 'PENDING') throw conflict('That proposal has already been decided.')

  const claimed = await repository.claimProposal(ctx, proposalId)
  if (claimed === 0) throw conflict('That proposal has already been decided.')

  const outcome = await invokeTool(ctx, proposal.toolName, proposal.args, { allowWrites: true })

  await repository.settleProposal(ctx, proposalId, {
    status: outcome.ok ? 'ACCEPTED' : 'FAILED',
    outcome: { ok: outcome.ok, content: outcome.content.slice(0, 1_000) },
  })

  await writeAuditLog({
    action: outcome.ok ? 'ai.proposal.accepted' : 'ai.proposal.failed',
    entityType: 'AIProposal',
    entityId: proposalId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { toolName: proposal.toolName },
  })

  await repository.settleRunIfDone(ctx, proposal.runId)

  return {
    ok: outcome.ok,
    message: outcome.ok ? 'Done.' : `That could not be carried out: ${outcome.content}`,
  }
}

export async function rejectProposal(ctx: Ctx, proposalId: string): Promise<void> {
  ctx.require('ai.use')

  const proposal = await repository.findProposal(ctx, proposalId)
  if (!proposal) throw notFound('That proposal is not available.')
  if (proposal.status !== 'PENDING') throw conflict('That proposal has already been decided.')

  await repository.settleProposal(ctx, proposalId, { status: 'REJECTED', outcome: null })

  await writeAuditLog({
    action: 'ai.proposal.rejected',
    entityType: 'AIProposal',
    entityId: proposalId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
  })

  await repository.settleRunIfDone(ctx, proposal.runId)
}
