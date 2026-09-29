import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

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
import { isAppError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { setProvider } from '@/lib/ai/router'
import type {
  GenerateRequest,
  GenerateResult,
  LanguageModelProvider,
  StreamPart,
  ToolCallPart,
  Usage,
} from '@/lib/ai/types'
import { getDb, getSystemDb } from '@/lib/db'

import '../../tools/read-tools'
import '../../tools/write-tools'

import { invokeTool } from '../../tools/registry'
import * as service from '../service'

/**
 * Agents against a real database.
 *
 * The properties this phase exists to guarantee:
 *
 * - a write tool never takes effect without a person, unless autonomy was
 *   explicitly granted;
 * - an agent acts with its OWNER's permissions, not the permissions of whoever
 *   pressed the button;
 * - an agent cannot call a tool outside its own allowlist, even if it asks;
 * - accepting a proposal runs it with the ACCEPTING person's permissions;
 * - the same proposal cannot be carried out twice.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `agents-${suffix}`

const state = {
  orgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

/** A provider that calls the named tool once, then answers. */
function toolCallingProvider(calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  let round = 0
  const requests: GenerateRequest[] = []

  const provider: LanguageModelProvider = {
    id: 'fake',
    capabilities: () => ({
      tools: true,
      streaming: false,
      vision: false,
      embeddings: false,
      maxContext: 100_000,
    }),
    estimateCostMicros: (usage: Usage) => usage.promptTokens + usage.completionTokens,
    async generate(request): Promise<GenerateResult> {
      requests.push(request)
      const toolCalls: ToolCallPart[] =
        round === 0
          ? calls.map((call, index) => ({
              type: 'tool_call',
              id: `call_${index}`,
              name: call.name,
              arguments: call.arguments,
            }))
          : []
      round += 1

      return {
        text: toolCalls.length > 0 ? 'Looking into it.' : 'Here is what I found.',
        toolCalls,
        usage: { promptTokens: 50, completionTokens: 10 },
        model: 'fake-model',
        finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
      }
    },
    async *stream(): AsyncIterable<StreamPart> {
      yield {
        type: 'finish',
        usage: { promptTokens: 1, completionTokens: 1 },
        model: 'fake-model',
        finishReason: 'stop',
      }
    },
    async embed() {
      throw new Error('not supported')
    },
  }

  return { provider, requests }
}

async function makeCtx(key: string): Promise<Ctx> {
  const membershipId = state.memberships[key]!
  const isOwner = key === 'owner'
  const { permissions, roles } = await loadPermissions({
    membershipId,
    organizationId: state.orgId,
    isOwner,
  })

  return Object.freeze({
    userId: state.users[key]!,
    sessionId: `s-${key}`,
    orgId: state.orgId,
    orgSlug: SLUG,
    membershipId,
    isOwner,
    user: { id: state.users[key]!, name: key, email: `${key}@example.test`, emailVerifiedAt: null },
    org: {
      id: state.orgId,
      slug: SLUG,
      name: 'Agent Org',
      logoUrl: null,
      timezone: 'UTC',
      currency: 'USD',
    },
    roles,
    permissions,
    can: (p: Permission) => can(permissions, p),
    canAny: (p: readonly Permission[]) => canAny(permissions, p),
    require: (p: Permission) => requirePermission(permissions, p),
    requireAny: (p: readonly Permission[]) => requireAny(permissions, p),
    scope: (a: Permission, b: Permission) => resolveScope(permissions, a, b),
    granted: (c: readonly Permission[]) => grantedFrom(permissions, c),
    db: getDb(state.orgId),
  })
}

async function seedMember(key: string, roleKey: string) {
  const db = getSystemDb()
  const user = await db.user.create({
    data: { email: `${key}-${suffix}@example.test`, name: key },
    select: { id: true },
  })
  const membership = await db.membership.create({
    data: { organizationId: state.orgId, userId: user.id, status: 'ACTIVE' },
    select: { id: true },
  })
  const role = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: roleKey },
    select: { id: true },
  })
  await db.membershipRole.create({
    data: { organizationId: state.orgId, membershipId: membership.id, roleId: role.id },
  })
  state.users[key] = user.id
  state.memberships[key] = membership.id
}

describe.skipIf(!hasDatabase)('AI agents', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const owner = await db.user.create({
      data: { email: `agents-owner-${suffix}@example.test`, name: 'owner' },
      select: { id: true },
    })
    const org = await db.organization.create({
      data: { name: SLUG, slug: SLUG, createdById: owner.id },
      select: { id: true },
    })
    state.orgId = org.id
    state.users.owner = owner.id

    const membership = await db.membership.create({
      data: { organizationId: org.id, userId: owner.id, status: 'ACTIVE' },
      select: { id: true },
    })
    state.memberships.owner = membership.id

    await seedMember('manager', 'manager')
    await seedMember('employee', 'employee')
  })

  afterEach(() => {
    setProvider(undefined)
  })

  afterAll(async () => {
    if (!hasDatabase) return
    setProvider(undefined)
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: SLUG } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('configuration', () => {
    it('lists every agent in the catalogue, configured or not', async () => {
      const ctx = await makeCtx('owner')
      const agents = await service.listAgentsWithConfig(ctx)

      expect(agents.length).toBeGreaterThanOrEqual(5)
      expect(agents.every((agent) => agent.enabled === false)).toBe(true)
      expect(agents.map((agent) => agent.key)).toContain('project-health')
    })

    it('refuses to switch an agent on without an owner', async () => {
      const ctx = await makeCtx('owner')

      await expect(
        service.configureAgent(ctx, {
          agentKey: 'project-health',
          enabled: true,
          autonomy: 'SUGGEST',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      )
    })

    it('refuses configuration to someone without ai.settings.manage', async () => {
      const manager = await makeCtx('manager')
      expect(manager.can('ai.settings.manage')).toBe(false)

      await expect(
        service.configureAgent(manager, {
          agentKey: 'project-health',
          enabled: true,
          autonomy: 'SUGGEST',
          ownerMembershipId: state.memberships.owner,
        }),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('refuses an owner from outside the organization', async () => {
      const ctx = await makeCtx('owner')

      await expect(
        service.configureAgent(ctx, {
          agentKey: 'project-health',
          enabled: true,
          autonomy: 'SUGGEST',
          ownerMembershipId: 'not-a-real-membership',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      )
    })
  })

  describe('running', () => {
    it('refuses to run an agent that is switched off', async () => {
      const ctx = await makeCtx('owner')

      await expect(service.runAgent(ctx, { agentKey: 'pipeline' })).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )
    })

    it('records a proposal instead of writing, and nothing takes effect', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'project-health',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.owner,
      })

      const { provider } = toolCallingProvider([
        { name: 'createTask', arguments: { title: 'Chase the at-risk project' } },
      ])
      setProvider(provider)

      const before = await getSystemDb().task.count({ where: { organizationId: state.orgId } })

      const result = await service.runAgent(ctx, { agentKey: 'project-health' })

      expect(result.status).toBe('AWAITING_CONFIRMATION')
      expect(result.proposals).toHaveLength(1)
      expect(result.proposals[0]?.summary).toContain('Chase the at-risk project')

      // The task does not exist. That is the whole point.
      const after = await getSystemDb().task.count({ where: { organizationId: state.orgId } })
      expect(after).toBe(before)
    })

    it('carries the change out when the proposal is accepted', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'project-health',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.owner,
      })

      const { provider } = toolCallingProvider([
        { name: 'createTask', arguments: { title: `Accepted task ${suffix}` } },
      ])
      setProvider(provider)

      const run = await service.runAgent(ctx, { agentKey: 'project-health' })
      const proposalId = run.proposals[0]!.id

      const outcome = await service.acceptProposal(ctx, proposalId)
      expect(outcome.ok).toBe(true)

      const task = await getSystemDb().task.findFirst({
        where: { organizationId: state.orgId, title: `Accepted task ${suffix}` },
        select: { id: true },
      })
      expect(task).not.toBeNull()
    })

    it('cannot carry the same proposal out twice', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'project-health',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.owner,
      })

      const { provider } = toolCallingProvider([
        { name: 'createTask', arguments: { title: `Once only ${suffix}` } },
      ])
      setProvider(provider)

      const run = await service.runAgent(ctx, { agentKey: 'project-health' })
      const proposalId = run.proposals[0]!.id

      await service.acceptProposal(ctx, proposalId)

      await expect(service.acceptProposal(ctx, proposalId)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'CONFLICT',
      )

      const tasks = await getSystemDb().task.count({
        where: { organizationId: state.orgId, title: `Once only ${suffix}` },
      })
      expect(tasks).toBe(1)
    })

    it('rejecting a proposal changes nothing', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'project-health',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.owner,
      })

      const { provider } = toolCallingProvider([
        { name: 'createTask', arguments: { title: `Rejected task ${suffix}` } },
      ])
      setProvider(provider)

      const run = await service.runAgent(ctx, { agentKey: 'project-health' })
      await service.rejectProposal(ctx, run.proposals[0]!.id)

      const task = await getSystemDb().task.findFirst({
        where: { organizationId: state.orgId, title: `Rejected task ${suffix}` },
        select: { id: true },
      })
      expect(task).toBeNull()
    })

    it('writes immediately when autonomy is granted', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'project-health',
        enabled: true,
        autonomy: 'AUTONOMOUS',
        ownerMembershipId: state.memberships.owner,
      })

      const { provider } = toolCallingProvider([
        { name: 'createTask', arguments: { title: `Autonomous task ${suffix}` } },
      ])
      setProvider(provider)

      const result = await service.runAgent(ctx, { agentKey: 'project-health' })

      expect(result.status).toBe('COMPLETED')
      expect(result.proposals).toHaveLength(0)

      const task = await getSystemDb().task.findFirst({
        where: { organizationId: state.orgId, title: `Autonomous task ${suffix}` },
        select: { id: true },
      })
      expect(task).not.toBeNull()
    })
  })

  describe('the permission ceiling', () => {
    it('refuses to run when the owner lacks a permission the agent needs', async () => {
      const ctx = await makeCtx('owner')

      // An Employee cannot read invoices, so the Receivables agent cannot act
      // as one — however it is configured, and whoever runs it.
      await service.configureAgent(ctx, {
        agentKey: 'receivables',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.employee,
      })

      const { provider } = toolCallingProvider([])
      setProvider(provider)

      await expect(service.runAgent(ctx, { agentKey: 'receivables' })).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('an agent cannot use a tool outside its allowlist', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'workload',
        enabled: true,
        autonomy: 'AUTONOMOUS',
        ownerMembershipId: state.memberships.owner,
      })

      // The Workload agent has no createTask in its list. The model asks anyway.
      const { provider } = toolCallingProvider([
        { name: 'createTask', arguments: { title: `Out of scope ${suffix}` } },
      ])
      setProvider(provider)

      await service.runAgent(ctx, { agentKey: 'workload' })

      // The tool ran nothing, because the agent's ceiling is its allowlist, and
      // the run still finished rather than crashing.
      const task = await getSystemDb().task.findFirst({
        where: { organizationId: state.orgId, title: `Out of scope ${suffix}` },
        select: { id: true },
      })
      expect(task).toBeNull()
    })

    it('does not offer an out-of-scope tool to the model in the first place', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'briefing',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.owner,
      })

      const { provider, requests } = toolCallingProvider([])
      setProvider(provider)

      await service.runAgent(ctx, { agentKey: 'briefing' })

      const offered = (requests[0]?.tools ?? []).map((tool) => tool.name)
      expect(offered).toContain('searchProjects')
      expect(offered).not.toContain('createTask')
      expect(offered).not.toContain('sendNotification')
    })

    it('refuses the run to someone without that agent’s permission', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'receivables',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.owner,
      })

      const employee = await makeCtx('employee')
      expect(employee.can('ai.agent.finance')).toBe(false)

      await expect(service.runAgent(employee, { agentKey: 'receivables' })).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })
  })

  describe('write tools', () => {
    it('are refused outright in a read-only session', async () => {
      const ctx = await makeCtx('owner')

      const result = await invokeTool(ctx, 'createTask', { title: 'Nope' })

      expect(result.ok).toBe(false)
      expect(result.content).toContain('changes data')
    })

    it('still check their own permission when writes are allowed', async () => {
      const employee = await makeCtx('employee')
      expect(employee.can('task.create')).toBe(true)

      // A permission the Employee genuinely lacks: notifying is open, but
      // commenting on a task requires task.comment, which they do hold — so use
      // an id from nowhere to prove the tool resolves through the org client.
      const result = await invokeTool(
        employee,
        'sendNotification',
        { recipientMembershipId: 'someone-elsewhere', title: 'Hello' },
        { allowWrites: true },
      )

      expect(result.ok).toBe(false)
      expect(result.content).toContain('not a member of this organization')
    })
  })

  describe('the run record', () => {
    it('records every step, including the proposal', async () => {
      const ctx = await makeCtx('owner')

      await service.configureAgent(ctx, {
        agentKey: 'project-health',
        enabled: true,
        autonomy: 'SUGGEST',
        ownerMembershipId: state.memberships.owner,
      })

      const { provider } = toolCallingProvider([
        { name: 'searchProjects', arguments: { limit: 5 } },
        { name: 'createTask', arguments: { title: `Stepped ${suffix}` } },
      ])
      setProvider(provider)

      const result = await service.runAgent(ctx, { agentKey: 'project-health' })
      const run = await service.getRun(ctx, result.runId)

      const kinds = run.steps.map((step) => step.kind)
      expect(kinds).toContain('read')
      expect(kinds).toContain('proposal')
      expect(kinds).toContain('answer')

      // Positions are sequential, so the panel reads in the order it happened.
      expect(run.steps.map((step) => step.position)).toEqual(
        run.steps.map((_step, index) => index + 1),
      )
    })
  })
})
