import { writeAuditLog } from '@/kernel/audit/write'
import { notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'

import { getAgent, listAgents } from './registry'
import * as repository from './repository'
import { acceptProposal, rejectProposal, runAgent } from './runtime'

export { acceptProposal, rejectProposal, runAgent }

/**
 * Agents.
 *
 * The catalogue is code; a row only says whether an organization has switched
 * one on, who it acts as and how far it may go. Listing merges the two so the
 * settings screen shows every agent that exists, not only the configured ones.
 */
export async function listAgentsWithConfig(ctx: Ctx) {
  ctx.require('ai.use')

  const configs = await repository.listConfigs(ctx)
  const byKey = new Map(configs.map((config) => [config.agentKey, config]))

  return listAgents().map((agent) => {
    const config = byKey.get(agent.key)

    return {
      key: agent.key,
      name: agent.name,
      description: agent.description,
      whatItDoes: agent.whatItDoes,
      tools: agent.tools,
      writeTools: agent.writeTools,
      permission: agent.permission,
      enabled: config?.enabled ?? false,
      autonomy: config?.autonomy ?? 'SUGGEST',
      owner: config?.owner?.user.name ?? null,
      ownerMembershipId: config?.ownerMembershipId ?? null,
      extraInstructions: config?.extraInstructions ?? null,
      // What the VIEWER may do, resolved server-side so the UI never guesses.
      canRun: ctx.can(agent.permission),
    }
  })
}

export async function configureAgent(
  ctx: Ctx,
  input: {
    agentKey: string
    enabled: boolean
    autonomy: 'SUGGEST' | 'AUTONOMOUS'
    ownerMembershipId?: string | undefined
    extraInstructions?: string | undefined
  },
): Promise<void> {
  ctx.require('ai.settings.manage')

  const agent = getAgent(input.agentKey)
  if (!agent) throw notFound('That agent is not available.')

  // The owner is resolved through the org-scoped client, so a membership id
  // from another tenant does not exist.
  let ownerMembershipId: string | null = null
  if (input.ownerMembershipId) {
    const membership = await ctx.db.membership.findFirst({
      where: { id: input.ownerMembershipId, status: 'ACTIVE' },
      select: { id: true },
    })
    if (!membership) throw validationError('That person is not a member of this organization.')
    ownerMembershipId = membership.id
  }

  if (input.enabled && !ownerMembershipId) {
    throw validationError('Choose who this agent acts as before switching it on.', {
      ownerMembershipId: ['An agent needs an owner.'],
    })
  }

  await repository.upsertConfig(ctx, {
    agentKey: input.agentKey,
    enabled: input.enabled,
    autonomy: input.autonomy,
    ownerMembershipId,
    extraInstructions: input.extraInstructions ?? null,
  })

  await writeAuditLog({
    action: 'ai.agent.configured',
    entityType: 'AIAgentConfig',
    entityId: input.agentKey,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { enabled: String(input.enabled), autonomy: input.autonomy },
  })
}

export const listRuns = (ctx: Ctx, agentKey?: string) => {
  ctx.require('ai.use')
  return repository.listRuns(ctx, agentKey)
}

export async function getRun(ctx: Ctx, id: string) {
  ctx.require('ai.use')
  const run = await repository.findRun(ctx, id)
  if (!run) throw notFound('That run is not available.')
  return run
}

export const listPendingProposals = (ctx: Ctx) => {
  ctx.require('ai.use')
  return repository.listPendingProposals(ctx)
}
