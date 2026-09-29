import { z } from 'zod'

import { getSystemDb } from '@/lib/db'
import { getMailer } from '@/lib/email/mailer'

import { registerAction, type ActionContext } from './registry'

/**
 * The built-in actions.
 *
 * Three properties hold for every one of them, and they are what make an
 * automation engine safe to hand to a non-developer:
 *
 * 1. **It runs as the workflow owner.** `context.ctx` is built from the owner's
 *    membership, so every write goes through the org-scoped client and the
 *    owner's permissions. A workflow cannot reach another tenant, and cannot do
 *    something its owner could not do by hand.
 * 2. **It declares what it needs.** The validator refuses to publish a workflow
 *    whose owner lacks a permission one of its actions requires, so the failure
 *    is at publish time rather than three weeks later at 2am.
 * 3. **A dry run performs nothing.** Test runs describe what would happen.
 *    Anything else makes "try it and see" a destructive operation.
 */

const template = z.string().min(1).max(500)

/**
 * Substitute `{{field}}` from the run data.
 *
 * Deliberately not a template engine: one regex, flat keys only, and an unknown
 * key renders as empty rather than throwing. Anything richer becomes a place to
 * evaluate expressions, which is exactly what this design avoids.
 */
export function renderTemplate(input: string, data: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    const value = data[key]
    if (value === null || value === undefined) return ''
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value)
  })
}

/* ------------------------------ notifications ------------------------------ */

registerAction({
  type: 'notification.send',
  label: 'Send a notification',
  description: 'Sends an in-app notification to a member.',
  category: 'Communication',
  configSchema: z.object({
    recipientMembershipId: z.string().min(1).max(64),
    title: template,
    body: z.string().max(500).optional(),
  }),
  requiredPermissions: [],
  idempotent: false,
  sideEffect: 'internal',
  async execute(context, config) {
    const title = renderTemplate(config.title, context.data)
    const body = config.body ? renderTemplate(config.body, context.data) : null

    // The recipient id comes from a stored config, which is untrusted input
    // however long ago it was written. Resolving it through the org-scoped
    // client means an id from another tenant simply does not exist here.
    const recipient = await context.ctx.db.membership.findFirst({
      where: { id: config.recipientMembershipId, status: 'ACTIVE' },
      select: { id: true },
    })

    if (!recipient) throw new Error('That recipient is not a member of this organization.')

    if (context.dryRun) {
      return { wouldNotify: recipient.id, title, body }
    }

    await getSystemDb().notification.create({
      data: {
        organizationId: context.ctx.orgId,
        recipientMembershipId: config.recipientMembershipId,
        type: 'workflow.notification',
        title,
        body,
        entityType: 'WorkflowRun',
        entityId: context.runId,
        priority: 'NORMAL',
        channels: ['IN_APP'],
      },
    })

    return { notified: config.recipientMembershipId }
  },
})

/* ---------------------------------- tasks ---------------------------------- */

registerAction({
  type: 'task.create',
  label: 'Create a task',
  description: 'Creates a task, optionally assigned to someone.',
  category: 'Work',
  configSchema: z.object({
    title: template,
    description: z.string().max(2000).optional(),
    assigneeMembershipId: z.string().max(64).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    dueInDays: z.number().int().min(0).max(365).optional(),
  }),
  requiredPermissions: ['task.create'],
  idempotent: false,
  sideEffect: 'internal',
  async execute(context, config) {
    const title = renderTemplate(config.title, context.data)

    if (context.dryRun) return { wouldCreateTask: title }

    const dueDate =
      config.dueInDays === undefined ? null : new Date(Date.now() + config.dueInDays * 86_400_000)

    // The counter claim is one statement so two concurrent runs cannot take
    // the same task number. The organization is a bound parameter, never
    // interpolated, and the task itself is written through the org-scoped
    // client.
    const numberRow = await getSystemDb().$queryRaw<Array<{ lastNumber: number }>>`
      INSERT INTO "TaskCounter" ("id", "organizationId", "lastNumber")
      VALUES (gen_random_uuid()::text, ${context.ctx.orgId}, 1)
      ON CONFLICT ("organizationId")
      DO UPDATE SET "lastNumber" = "TaskCounter"."lastNumber" + 1
      RETURNING "lastNumber"
    `

    // An assignee named in the config is checked the same way as a recipient.
    let assigneeMembershipId: string | null = null
    if (config.assigneeMembershipId) {
      const assignee = await context.ctx.db.membership.findFirst({
        where: { id: config.assigneeMembershipId, status: 'ACTIVE' },
        select: { id: true },
      })
      assigneeMembershipId = assignee?.id ?? null
    }

    const task = await context.ctx.db.task.create({
      data: {
        organizationId: context.ctx.orgId,
        number: numberRow[0]?.lastNumber ?? 1,
        title: title.slice(0, 200),
        description: config.description ? renderTemplate(config.description, context.data) : null,
        status: 'TODO',
        priority: config.priority,
        assigneeMembershipId,
        dueDate,
        createdById: context.ctx.userId,
        boardOrder: Date.now(),
      } as never,
      select: { id: true, number: true },
    })

    return { taskId: task.id, taskNumber: task.number }
  },
})

/* -------------------------------- activity --------------------------------- */

registerAction({
  type: 'activity.log',
  label: 'Record an activity entry',
  description: 'Adds a line to the activity feed. No side effects beyond the feed.',
  category: 'Records',
  configSchema: z.object({
    summary: template,
    entityType: z.string().max(40).default('Workflow'),
  }),
  requiredPermissions: [],
  idempotent: true,
  sideEffect: 'none',
  async execute(context, config) {
    const summary = renderTemplate(config.summary, context.data)
    if (context.dryRun) return { wouldLog: summary }

    await getSystemDb().activityLog.create({
      data: {
        organizationId: context.ctx.orgId,
        entityType: config.entityType,
        entityId: context.runId,
        actorId: context.ctx.userId,
        actorType: 'WORKFLOW',
        verb: 'automated',
        summary: summary.slice(0, 300),
      },
    })

    return { logged: true }
  },
})

/* ---------------------------------- email ---------------------------------- */

registerAction({
  type: 'email.send',
  label: 'Send an email',
  description: 'Emails a member of this organization.',
  category: 'Communication',
  configSchema: z.object({
    recipientMembershipId: z.string().min(1).max(64),
    subject: template,
    body: z.string().min(1).max(4000),
  }),
  requiredPermissions: [],
  idempotent: false,
  sideEffect: 'external',
  async execute(context, config) {
    const subject = renderTemplate(config.subject, context.data)
    const body = renderTemplate(config.body, context.data)

    // The recipient is resolved through the org-scoped client, so an address
    // outside this organization cannot be reached however the config is written.
    const membership = await context.ctx.db.membership.findFirst({
      where: { id: config.recipientMembershipId, status: 'ACTIVE' },
      select: { user: { select: { email: true, name: true } } },
    })

    if (!membership) throw new Error('That recipient is not a member of this organization.')

    if (context.dryRun) return { wouldEmail: membership.user.email, subject }

    await getMailer().send({ to: membership.user.email, subject, text: body })
    return { emailed: membership.user.email }
  },
})

/** Import for the side effect of registering everything above. */
export const BUILT_IN_ACTIONS_LOADED = true

/** Re-exported so the engine can build an action context without importing zod. */
export type { ActionContext }
