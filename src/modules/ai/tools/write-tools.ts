import { z } from 'zod'

import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'
import * as taskActions from '@/modules/tasks/queries'

import { defineTool } from './registry'

/**
 * The write tools.
 *
 * Every one of them is `sideEffect: 'write'`, which means the registry refuses
 * it unless the session has explicitly opted in — and the agent runtime only
 * opts in when the agent has been granted autonomy by someone who holds the
 * permissions the tool needs. In every other case the agent's request becomes a
 * PROPOSAL that a person accepts or rejects.
 *
 * Each one still checks its own permission through the service, because a tool
 * is never trusted to be the only guard. And each takes ids that are resolved
 * through the org-scoped client, so an id from another tenant does not exist.
 */

const meta = { ip: null, userAgent: 'ai-agent' }

defineTool({
  name: 'createTask',
  description:
    'Create a task. Use this for follow-up work you have identified. Say what it is for in the description.',
  parameters: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2_000).optional(),
    assigneeMembershipId: z.string().max(64).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    dueInDays: z.number().int().min(0).max(365).optional(),
    projectId: z.string().max(64).optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      assigneeMembershipId: { type: 'string', description: 'From searchPeople.' },
      priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
      dueInDays: { type: 'number' },
      projectId: { type: 'string', description: 'From searchProjects.' },
    },
    required: ['title'],
  },
  requiredPermissions: ['task.create'],
  sideEffect: 'write',
  async handler(ctx: Ctx, args) {
    const result = await taskActions.createTaskForAgent(ctx, {
      title: args.title,
      description: args.description,
      assigneeMembershipId: args.assigneeMembershipId,
      priority: args.priority,
      projectId: args.projectId,
      dueDate:
        args.dueInDays === undefined
          ? undefined
          : new Date(Date.now() + args.dueInDays * 86_400_000),
    })

    return { taskId: result.id, number: result.number }
  },
})

defineTool({
  name: 'sendNotification',
  description: 'Send an in-app notification to one member of this organization.',
  parameters: z.object({
    recipientMembershipId: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    body: z.string().max(500).optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      recipientMembershipId: { type: 'string', description: 'From searchPeople.' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['recipientMembershipId', 'title'],
  },
  requiredPermissions: [],
  sideEffect: 'write',
  async handler(ctx: Ctx, args) {
    // Resolved through the org-scoped client: a membership id the agent read
    // somewhere else does not exist here.
    const recipient = await ctx.db.membership.findFirst({
      where: { id: args.recipientMembershipId, status: 'ACTIVE' },
      select: { id: true },
    })
    if (!recipient) throw new Error('That person is not a member of this organization.')

    await getSystemDb().notification.create({
      data: {
        organizationId: ctx.orgId,
        recipientMembershipId: recipient.id,
        type: 'ai.agent',
        title: args.title,
        body: args.body ?? null,
        entityType: 'AIAgentRun',
        entityId: 'agent',
        priority: 'NORMAL',
        channels: ['IN_APP'],
      },
    })

    return { notified: recipient.id }
  },
})

defineTool({
  name: 'addTaskComment',
  description: 'Add a comment to a task — for example to record what you found.',
  parameters: z.object({
    taskId: z.string().min(1).max(64),
    body: z.string().min(1).max(2_000),
  }),
  jsonSchema: {
    type: 'object',
    properties: { taskId: { type: 'string' }, body: { type: 'string' } },
    required: ['taskId', 'body'],
  },
  requiredPermissions: ['task.comment'],
  sideEffect: 'write',
  async handler(ctx: Ctx, args) {
    await taskActions.addCommentForAgent(ctx, { taskId: args.taskId, body: args.body }, meta)
    return { commented: args.taskId }
  },
})
