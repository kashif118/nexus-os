import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, forbidden, notFound, validationError } from '@/kernel/errors'
import { buildMembershipCtx, type Ctx } from '@/kernel/tenancy/ctx'

import './templates'

import * as repository from './repository'
import { getTemplate, templatesFor, type ReportOutput } from './templates'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * Reports.
 *
 * A saved report is its parameters. Generating it re-runs the template against
 * current data with the CALLER's context, so two people with different
 * permissions opening the same saved report each see what they are entitled
 * to — and neither sees a figure the other's screens would hide.
 */

export const availableTemplates = (ctx: Ctx) =>
  templatesFor(ctx).map((template) => ({
    key: template.key,
    name: template.name,
    description: template.description,
    fields: template.fields,
  }))

export async function listReports(ctx: Ctx) {
  ctx.require('report.view')

  const reports = await repository.listReports(ctx)
  const allowed = new Set(templatesFor(ctx).map((template) => template.key))

  // A report whose template the caller may not run is not listed: its NAME
  // would otherwise describe a figure they are not entitled to.
  return reports
    .filter((report) => allowed.has(report.template))
    .map((report) => ({
      ...report,
      templateName: getTemplate(report.template)?.name ?? report.template,
    }))
}

export async function createReport(
  ctx: Ctx,
  input: { template: string; name: string; period?: string | undefined; schedule: string | null },
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('report.generate')

  const template = getTemplate(input.template)
  if (!template) throw validationError('That report does not exist.')

  if (!template.requires.every((permission) => ctx.can(permission))) {
    throw forbidden('You do not have access to that report.')
  }

  if (input.schedule && !ctx.can('report.schedule')) {
    throw forbidden('You do not have permission to schedule reports.')
  }

  // Parameters are validated by the TEMPLATE's own schema, so a saved report
  // cannot carry values the template would choke on next month.
  const parsed = template.parameters.safeParse({
    ...(input.period ? { period: input.period } : {}),
  })

  if (!parsed.success) {
    throw validationError('Those report options are not valid.')
  }

  try {
    const report = await repository.createReport(ctx, {
      template: input.template,
      name: input.name,
      parameters: parsed.data as never,
      schedule: input.schedule,
      recipientMembershipIds: input.schedule ? [ctx.membershipId] : [],
    })

    await writeAuditLog({
      action: 'report.created',
      entityType: 'Report',
      entityId: report.id,
      organizationId: ctx.orgId,
      actorId: ctx.userId,
      metadata: { template: input.template, schedule: input.schedule ?? 'none' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    return { id: report.id }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('A report with that name already exists.', { name: ['Already in use.'] })
    }
    throw error
  }
}

export async function deleteReport(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('report.generate')

  const removed = await repository.softDeleteReport(ctx, id)
  if (removed === 0) throw notFound('That report is not available.')

  await writeAuditLog({
    action: 'report.deleted',
    entityType: 'Report',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Generate a saved report.
 *
 * Always re-run: a report shows the data as it is now, not as it was when it
 * was saved. That is why nothing stores the rendered output.
 */
export async function generate(ctx: Ctx, id: string): Promise<ReportOutput> {
  ctx.require('report.view')

  const report = await repository.findReport(ctx, id)
  if (!report) throw notFound('That report is not available.')

  const template = getTemplate(report.template)
  if (!template) throw conflict('That report uses a template this version no longer has.')

  if (!template.requires.every((permission) => ctx.can(permission))) {
    throw notFound('That report is not available.')
  }

  const parsed = template.parameters.safeParse(report.parameters ?? {})
  if (!parsed.success) throw conflict('That report has options this version no longer accepts.')

  return template.build(ctx, parsed.data as never)
}

/** Generate a template directly, without saving it first. */
export async function preview(
  ctx: Ctx,
  templateKey: string,
  params: Record<string, unknown>,
): Promise<ReportOutput> {
  ctx.require('report.generate')

  const template = getTemplate(templateKey)
  if (!template) throw notFound('That report does not exist.')
  if (!template.requires.every((permission) => ctx.can(permission))) {
    throw notFound('That report does not exist.')
  }

  const parsed = template.parameters.safeParse(params)
  if (!parsed.success) throw validationError('Those report options are not valid.')

  return template.build(ctx, parsed.data as never)
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

const INTERVALS: Record<string, number> = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
}

/** True when a schedule is due, given when it last ran. */
export function isDue(schedule: string, lastRunAt: Date | null, now = new Date()): boolean {
  const interval = INTERVALS[schedule]
  if (!interval) return false
  if (!lastRunAt) return true
  return now.getTime() - lastRunAt.getTime() >= interval
}

/**
 * Run every scheduled report that is due.
 *
 * Each one is generated with a context built from the person who created it,
 * so a scheduled report can never show more than they could see — and if they
 * lose a permission, or leave, the report stops rather than quietly continuing
 * to send figures nobody is entitled to.
 */
export async function runDueReports(now = new Date()): Promise<{ ran: number; failed: number }> {
  const candidates = await repository.dueScheduledReports(now)
  let ran = 0
  let failed = 0

  for (const report of candidates) {
    if (!report.schedule || !isDue(report.schedule, report.lastRunAt, now)) continue

    try {
      if (!report.createdById) {
        throw new Error('This report has no owner, so it cannot be generated.')
      }

      const membership = await repository.membershipFor(report.organizationId, report.createdById)
      if (!membership) {
        throw new Error('The person who scheduled this report is no longer an active member.')
      }

      const ownerCtx = await buildMembershipCtx(report.organizationId, membership.id)
      if (!ownerCtx) throw new Error('The report owner could not be resolved.')

      await generate(ownerCtx, report.id)

      await repository.recordRun(report.id, { error: null })
      ran += 1
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'Generation failed.'
      // Recorded, not swallowed: a schedule that silently stopped working is
      // worse than one that visibly failed.
      await repository.recordRun(report.id, { error: message })
      failed += 1
    }
  }

  return { ran, failed }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
