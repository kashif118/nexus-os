import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

const live = { deletedAt: null }

export async function listReports(ctx: Ctx) {
  return ctx.db.report.findMany({
    where: live,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      template: true,
      name: true,
      parameters: true,
      schedule: true,
      recipientMembershipIds: true,
      lastRunAt: true,
      lastError: true,
      updatedAt: true,
    },
  })
}

export async function findReport(ctx: Ctx, id: string) {
  return ctx.db.report.findFirst({
    where: { id, ...live },
    select: {
      id: true,
      template: true,
      name: true,
      parameters: true,
      schedule: true,
      recipientMembershipIds: true,
      lastRunAt: true,
      lastError: true,
    },
  })
}

export async function createReport(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.report.create({
    data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId } as never,
    select: { id: true, name: true },
  })
}

export async function updateReport(ctx: Ctx, id: string, data: Record<string, unknown>) {
  const result = await ctx.db.report.updateMany({ where: { id, ...live }, data: data as never })
  return result.count
}

export async function softDeleteReport(ctx: Ctx, id: string) {
  const result = await ctx.db.report.updateMany({
    where: { id, ...live },
    data: { deletedAt: new Date() },
  })
  return result.count
}

/**
 * Reports with a schedule that are due.
 *
 * Read with the system client because the sweep runs outside any request; each
 * one is then generated with a context built from its creator, so a scheduled
 * report can never show more than the person who scheduled it could see.
 */
export async function dueScheduledReports(now: Date, limit = 20) {
  return getSystemDb().report.findMany({
    where: {
      deletedAt: null,
      schedule: { not: null },
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - 60_000) } }],
    },
    orderBy: { lastRunAt: 'asc' },
    take: limit,
    select: {
      id: true,
      organizationId: true,
      template: true,
      name: true,
      parameters: true,
      schedule: true,
      lastRunAt: true,
      recipientMembershipIds: true,
      createdById: true,
    },
  })
}

export async function recordRun(id: string, input: { error: string | null }): Promise<void> {
  await getSystemDb().report.update({
    where: { id },
    data: { lastRunAt: new Date(), lastError: input.error },
  })
}

/** The membership for a user in an organization, for the scheduled run. */
export async function membershipFor(organizationId: string, userId: string) {
  return getSystemDb().membership.findFirst({
    where: { organizationId, userId, status: 'ACTIVE' },
    select: { id: true },
  })
}
