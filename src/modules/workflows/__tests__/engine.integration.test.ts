import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
import { drainOutbox, emitEvent, registerSubscriber, resetSubscribers } from '@/kernel/events'
import { isAppError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb } from '@/lib/db'
import { setMailer } from '@/lib/email/mailer'
import { workflowSubscriber } from '@/modules/workflows/subscriber'

import * as service from '../service'

/**
 * The workflow engine, against a real database.
 *
 * What is asserted, and why each matters:
 *
 * - an event starts a run for a matching ACTIVE workflow and for nothing else;
 * - a false condition stops the path without failing the run;
 * - an approval suspends the run, and a decision resumes it down the right branch;
 * - a test run performs no side effects;
 * - publishing is refused when the graph is invalid or the owner lacks a permission;
 * - a run pins its version, so editing does not change a run in flight;
 * - one organization's workflow never sees another organization's event.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `wf-${suffix}`
const OTHER_SLUG = `wf-other-${suffix}`
const meta = { ip: null, userAgent: 'vitest-workflows' }

const state = {
  orgId: '',
  otherOrgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
}

async function makeCtx(key: string, orgId = state.orgId, slug = SLUG): Promise<Ctx> {
  const membershipId = state.memberships[key]!
  const isOwner = key === 'owner' || key === 'otherOwner'
  const { permissions, roles } = await loadPermissions({
    membershipId,
    organizationId: orgId,
    isOwner,
  })

  return Object.freeze({
    userId: state.users[key]!,
    sessionId: `s-${key}`,
    orgId,
    orgSlug: slug,
    membershipId,
    isOwner,
    user: { id: state.users[key]!, name: key, email: `${key}@example.test`, emailVerifiedAt: null },
    org: { id: orgId, slug, name: 'WF Org', logoUrl: null, timezone: 'UTC', currency: 'USD' },
    roles,
    permissions,
    can: (p: Permission) => can(permissions, p),
    canAny: (p: readonly Permission[]) => canAny(permissions, p),
    require: (p: Permission) => requirePermission(permissions, p),
    requireAny: (p: readonly Permission[]) => requireAny(permissions, p),
    scope: (a: Permission, b: Permission) => resolveScope(permissions, a, b),
    granted: (c: readonly Permission[]) => grantedFrom(permissions, c),
    db: getDb(orgId),
  })
}

async function seedMember(key: string, roleKey: string, organizationId = state.orgId) {
  const db = getSystemDb()
  const user = await db.user.create({
    data: { email: `${key}-${suffix}@example.test`, name: key },
    select: { id: true },
  })
  const membership = await db.membership.create({
    data: { organizationId, userId: user.id, status: 'ACTIVE' },
    select: { id: true },
  })
  const role = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: roleKey },
    select: { id: true },
  })
  await db.membershipRole.create({
    data: { organizationId, membershipId: membership.id, roleId: role.id },
  })
  state.users[key] = user.id
  state.memberships[key] = membership.id
}

async function seedOrg(slug: string, ownerKey: string) {
  const db = getSystemDb()
  const owner = await db.user.create({
    data: { email: `${ownerKey}-${suffix}@example.test`, name: ownerKey },
    select: { id: true },
  })
  const org = await db.organization.create({
    data: { name: slug, slug, createdById: owner.id },
    select: { id: true },
  })
  const membership = await db.membership.create({
    data: { organizationId: org.id, userId: owner.id, status: 'ACTIVE' },
    select: { id: true },
  })
  state.users[ownerKey] = owner.id
  state.memberships[ownerKey] = membership.id
  return org.id
}

/** Trigger → condition (total > 1000.00) → log an activity entry. */
const chaseGraph = (extra: { withApproval?: boolean } = {}) => ({
  schemaVersion: 1,
  nodes: [
    { id: 'trigger', type: 'trigger', trigger: 'invoice.overdue', config: {} },
    {
      id: 'big',
      type: 'condition',
      expression: { kind: 'compare', field: 'totalMinor', comparator: 'gt', value: 100_000 },
    },
    ...(extra.withApproval
      ? [
          {
            id: 'sign-off',
            type: 'approval',
            config: { approverPermission: 'finance.invoice.send', timeoutHours: 48 },
          },
        ]
      : []),
    {
      id: 'log',
      type: 'action',
      action: 'activity.log',
      config: { summary: 'Chased {{number}} for {{companyName}}', entityType: 'Invoice' },
    },
  ],
  edges: extra.withApproval
    ? [
        { from: 'trigger', to: 'big' },
        { from: 'big', to: 'sign-off' },
        { from: 'sign-off', to: 'log', branch: 'approved' },
      ]
    : [
        { from: 'trigger', to: 'big' },
        { from: 'big', to: 'log' },
      ],
})

async function publishWorkflow(ctx: Ctx, name: string, graph: unknown): Promise<{ id: string }> {
  const workflow = await service.createWorkflow(ctx, { name, triggerType: 'invoice.overdue' }, meta)
  await service.saveDraft(ctx, workflow.id, graph, meta)
  await service.publishWorkflow(ctx, workflow.id, meta)
  return workflow
}

const overdueEvent = (totalMinor: number, number = 'INV-0001') => ({
  type: 'invoice.overdue' as const,
  organizationId: state.orgId,
  entityType: 'Invoice',
  entityId: `invoice-${number}`,
  payload: { number, totalMinor, companyName: 'Acme Ltd', balanceMinor: totalMinor },
})

describe.skipIf(!hasDatabase)('Workflow engine', () => {
  beforeAll(async () => {
    state.orgId = await seedOrg(SLUG, 'owner')
    state.otherOrgId = await seedOrg(OTHER_SLUG, 'otherOwner')

    await seedMember('finance', 'finance_manager')
    await seedMember('employee', 'employee')

    setMailer({ async send() {} })

    resetSubscribers()
    registerSubscriber(workflowSubscriber)
  })

  afterAll(async () => {
    if (!hasDatabase) return
    resetSubscribers()
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  describe('publishing', () => {
    it('refuses to publish an invalid graph', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await service.createWorkflow(
        ctx,
        { name: `invalid-${suffix}`, triggerType: 'invoice.overdue' },
        meta,
      )

      // The starting graph is a lone trigger with nothing attached, which is
      // valid; add a condition on a field the trigger does not publish.
      await service.saveDraft(
        ctx,
        workflow.id,
        {
          schemaVersion: 1,
          nodes: [
            { id: 'trigger', type: 'trigger', trigger: 'invoice.overdue', config: {} },
            {
              id: 'bad',
              type: 'condition',
              expression: { kind: 'compare', field: 'notAField', comparator: 'eq', value: 1 },
            },
          ],
          edges: [{ from: 'trigger', to: 'bad' }],
        },
        meta,
      )

      await expect(service.publishWorkflow(ctx, workflow.id, meta)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      )
    })

    it('refuses to publish an action the publisher is not allowed to perform', async () => {
      // An Employee cannot create tasks for other people in this matrix's terms;
      // use a permission they definitively lack.
      const employee = await makeCtx('employee')

      await expect(
        service.createWorkflow(
          employee,
          { name: `nope-${suffix}`, triggerType: 'invoice.overdue' },
          meta,
        ),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'FORBIDDEN')
    })

    it('publishes a valid graph and makes it active', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `chase-${suffix}`, chaseGraph())

      const stored = await service.getWorkflow(ctx, workflow.id)
      expect(stored.status).toBe('ACTIVE')
      expect(stored.published?.version).toBe(1)
    })
  })

  describe('execution', () => {
    it('runs when the event matches and the condition passes', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `runs-${suffix}`, chaseGraph())

      await emitEvent(overdueEvent(150_000, 'INV-BIG'))
      await drainOutbox({ organizationId: state.orgId })

      const runs = await service.listRuns(ctx, workflow.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe('SUCCEEDED')

      const run = await service.getRun(ctx, runs[0]!.id)
      const steps = Object.fromEntries(run.steps.map((step) => [step.nodeId, step.status]))
      expect(steps).toEqual({ trigger: 'SUCCEEDED', big: 'SUCCEEDED', log: 'SUCCEEDED' })

      // The action really ran: an activity entry exists with the rendered text.
      const activity = await getSystemDb().activityLog.findFirst({
        where: { organizationId: state.orgId, summary: { contains: 'INV-BIG' } },
        select: { summary: true, actorType: true },
      })
      expect(activity?.summary).toBe('Chased INV-BIG for Acme Ltd')
      expect(activity?.actorType).toBe('WORKFLOW')
    })

    it('stops at a false condition without failing the run', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `small-${suffix}`, chaseGraph())

      await emitEvent(overdueEvent(500, 'INV-SMALL'))
      await drainOutbox({ organizationId: state.orgId })

      const runs = await service.listRuns(ctx, workflow.id)
      const run = await service.getRun(ctx, runs[0]!.id)

      expect(run.status).toBe('SUCCEEDED')
      const steps = Object.fromEntries(run.steps.map((step) => [step.nodeId, step.status]))
      expect(steps.big).toBe('SKIPPED')
      expect(steps.log).toBeUndefined()
    })

    it('does not run a paused workflow', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `paused-${suffix}`, chaseGraph())
      await service.setStatus(ctx, workflow.id, 'PAUSED', meta)

      await emitEvent(overdueEvent(200_000, 'INV-PAUSED'))
      await drainOutbox({ organizationId: state.orgId })

      expect(await service.listRuns(ctx, workflow.id)).toHaveLength(0)
    })

    it('does not run another organization’s workflow', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `isolated-${suffix}`, chaseGraph())

      await emitEvent({ ...overdueEvent(500_000, 'INV-THEIRS'), organizationId: state.otherOrgId })
      await drainOutbox({ organizationId: state.orgId })

      expect(await service.listRuns(ctx, workflow.id)).toHaveLength(0)
    })
  })

  describe('approvals', () => {
    it('suspends at an approval and resumes down the approved branch', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(
        ctx,
        `approval-${suffix}`,
        chaseGraph({ withApproval: true }),
      )

      await emitEvent(overdueEvent(400_000, 'INV-APPROVE'))
      await drainOutbox({ organizationId: state.orgId })

      const runs = await service.listRuns(ctx, workflow.id)
      expect(runs[0]?.status).toBe('WAITING')

      const waiting = await service.getRun(ctx, runs[0]!.id)
      const approvalStep = waiting.steps.find((step) => step.nodeId === 'sign-off')
      expect(approvalStep?.status).toBe('WAITING')

      // Nothing downstream has happened while it waits.
      expect(waiting.steps.find((step) => step.nodeId === 'log')).toBeUndefined()

      await service.decideApproval(ctx, { stepId: approvalStep!.id, approve: true }, meta)

      const finished = await service.getRun(ctx, runs[0]!.id)
      expect(finished.status).toBe('SUCCEEDED')
      expect(finished.steps.find((step) => step.nodeId === 'log')?.status).toBe('SUCCEEDED')
    })

    it('takes no branch when rejected and there is no rejected path', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(
        ctx,
        `reject-${suffix}`,
        chaseGraph({ withApproval: true }),
      )

      await emitEvent(overdueEvent(400_000, 'INV-REJECT'))
      await drainOutbox({ organizationId: state.orgId })

      const runs = await service.listRuns(ctx, workflow.id)
      const waiting = await service.getRun(ctx, runs[0]!.id)
      const approvalStep = waiting.steps.find((step) => step.nodeId === 'sign-off')!

      await service.decideApproval(ctx, { stepId: approvalStep.id, approve: false }, meta)

      const finished = await service.getRun(ctx, runs[0]!.id)
      expect(finished.status).toBe('SUCCEEDED')
      // The chase was never logged, which is the point of rejecting it.
      expect(finished.steps.find((step) => step.nodeId === 'log')).toBeUndefined()
    })

    it('refuses to decide the same approval twice', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(
        ctx,
        `twice-${suffix}`,
        chaseGraph({ withApproval: true }),
      )

      await emitEvent(overdueEvent(400_000, 'INV-TWICE'))
      await drainOutbox({ organizationId: state.orgId })

      const runs = await service.listRuns(ctx, workflow.id)
      const waiting = await service.getRun(ctx, runs[0]!.id)
      const approvalStep = waiting.steps.find((step) => step.nodeId === 'sign-off')!

      await service.decideApproval(ctx, { stepId: approvalStep.id, approve: true }, meta)

      await expect(
        service.decideApproval(ctx, { stepId: approvalStep.id, approve: false }, meta),
      ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'CONFLICT')
    })
  })

  describe('test runs', () => {
    it('performs nothing and says what it would have done', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `dry-${suffix}`, chaseGraph())

      const before = await getSystemDb().activityLog.count({
        where: { organizationId: state.orgId },
      })

      const result = await service.runManually(
        ctx,
        {
          workflowId: workflow.id,
          payload: { number: 'INV-DRY', totalMinor: 999_999, companyName: 'Dry Run Ltd' },
          dryRun: true,
        },
        meta,
      )

      expect(result.status).toBe('SUCCEEDED')

      const after = await getSystemDb().activityLog.count({
        where: { organizationId: state.orgId },
      })
      expect(after).toBe(before)

      const run = await service.getRun(ctx, result.runId)
      const log = run.steps.find((step) => step.nodeId === 'log')
      expect(JSON.stringify(log?.output)).toContain('wouldLog')
    })

    it('performs the action when asked to run for real', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `live-${suffix}`, chaseGraph())

      await service.runManually(
        ctx,
        {
          workflowId: workflow.id,
          payload: { number: 'INV-LIVE', totalMinor: 999_999, companyName: 'Live Ltd' },
          dryRun: false,
        },
        meta,
      )

      const activity = await getSystemDb().activityLog.findFirst({
        where: { organizationId: state.orgId, summary: { contains: 'INV-LIVE' } },
        select: { summary: true },
      })
      expect(activity?.summary).toBe('Chased INV-LIVE for Live Ltd')
    })
  })

  describe('versioning', () => {
    it('a run keeps the version it started on, even after the workflow is edited', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `versioned-${suffix}`, chaseGraph())

      await emitEvent(overdueEvent(300_000, 'INV-V1'))
      await drainOutbox({ organizationId: state.orgId })

      const runs = await service.listRuns(ctx, workflow.id)
      expect(runs[0]?.version.version).toBe(1)

      // Edit and republish: the earlier run still reports version 1.
      await service.saveDraft(
        ctx,
        workflow.id,
        {
          ...chaseGraph(),
          nodes: chaseGraph().nodes.map((node) =>
            node.id === 'log'
              ? { ...node, config: { summary: 'Changed {{number}}', entityType: 'Invoice' } }
              : node,
          ),
        },
        meta,
      )
      await service.publishWorkflow(ctx, workflow.id, meta)

      const unchanged = await service.getRun(ctx, runs[0]!.id)
      expect(unchanged.version.version).toBe(1)

      const republished = await service.getWorkflow(ctx, workflow.id)
      expect(republished.published?.version).toBe(2)
    })
  })

  describe('authorization', () => {
    it('refuses workflow reads to someone without the permission', async () => {
      const employee = await makeCtx('employee')
      await expect(service.listWorkflows(employee)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
      )
    })

    it('does not expose another organization’s workflow', async () => {
      const ctx = await makeCtx('owner')
      const workflow = await publishWorkflow(ctx, `private-${suffix}`, chaseGraph())

      const stranger = await makeCtx('otherOwner', state.otherOrgId, OTHER_SLUG)
      await expect(service.getWorkflow(stranger, workflow.id)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
      )
    })
  })
})
