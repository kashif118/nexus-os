import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

/**
 * Notification and activity reads.
 *
 * A notification belongs to one membership, so every query here is keyed by
 * `ctx.membershipId` as well as being org-scoped. Notifications are personal:
 * there is no "read anyone's notifications" permission, because there is no
 * good reason for one.
 */

export async function listNotifications(
  ctx: Ctx,
  {
    unreadOnly = false,
    limit = 30,
    cursor,
  }: { unreadOnly?: boolean; limit?: number; cursor?: string },
) {
  return ctx.db.notification.findMany({
    where: {
      recipientMembershipId: ctx.membershipId,
      ...(unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      href: true,
      priority: true,
      readAt: true,
      createdAt: true,
      entityType: true,
      entityId: true,
    },
  })
}

export async function countUnread(ctx: Ctx): Promise<number> {
  return ctx.db.notification.count({
    where: { recipientMembershipId: ctx.membershipId, readAt: null },
  })
}

export async function markRead(ctx: Ctx, ids: string[]): Promise<number> {
  const result = await ctx.db.notification.updateMany({
    where: {
      id: { in: ids },
      recipientMembershipId: ctx.membershipId,
      readAt: null,
    },
    data: { readAt: new Date() },
  })
  return result.count
}

export async function markAllRead(ctx: Ctx): Promise<number> {
  const result = await ctx.db.notification.updateMany({
    where: { recipientMembershipId: ctx.membershipId, readAt: null },
    data: { readAt: new Date() },
  })
  return result.count
}

/* ------------------------------ preferences ------------------------------- */

export async function listPreferences(ctx: Ctx) {
  return ctx.db.notificationPreference.findMany({
    where: { membershipId: ctx.membershipId },
    select: { eventType: true, inApp: true, email: true, digest: true },
  })
}

export async function upsertPreference(
  ctx: Ctx,
  input: { eventType: string; inApp: boolean; email: boolean; digest: boolean },
) {
  return ctx.db.notificationPreference.upsert({
    where: {
      membershipId_eventType: { membershipId: ctx.membershipId, eventType: input.eventType },
    },
    create: {
      organizationId: ctx.orgId,
      membershipId: ctx.membershipId,
      eventType: input.eventType,
      inApp: input.inApp,
      email: input.email,
      digest: input.digest,
    },
    update: { inApp: input.inApp, email: input.email, digest: input.digest },
    select: { id: true },
  })
}

/* -------------------------------- activity -------------------------------- */

export async function listActivity(
  ctx: Ctx,
  filters: { entityType?: string | undefined; entityId?: string | undefined; limit?: number },
) {
  return ctx.db.activityLog.findMany({
    where: {
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: filters.limit ?? 30,
    select: {
      id: true,
      entityType: true,
      entityId: true,
      actorId: true,
      verb: true,
      summary: true,
      createdAt: true,
    },
  })
}

/* ---------------------- writes performed by subscribers -------------------- */

/**
 * The subscriber runs OUTSIDE a request, so it has no `Ctx` and uses the system
 * client. Every write below therefore passes `organizationId` explicitly, taken
 * from the event — which was written inside the organization's own transaction.
 */

export async function createNotifications(
  rows: Array<{
    organizationId: string
    recipientMembershipId: string
    type: string
    title: string
    body: string | null
    href: string | null
    entityType: string
    entityId: string
    actorId: string | null
    priority: 'LOW' | 'NORMAL' | 'HIGH'
    channels: string[]
  }>,
): Promise<number> {
  if (rows.length === 0) return 0
  const result = await getSystemDb().notification.createMany({ data: rows as never })
  return result.count
}

export async function writeActivity(input: {
  organizationId: string
  entityType: string
  entityId: string
  actorId: string | null
  verb: string
  summary: string | null
}): Promise<void> {
  await getSystemDb().activityLog.create({ data: input })
}

/** Members of an organization plus their preferences, for the fan-out. */
export async function recipientsByMembershipIds(organizationId: string, membershipIds: string[]) {
  if (membershipIds.length === 0) return []

  const rows = await getSystemDb().membership.findMany({
    where: { id: { in: membershipIds }, organizationId, status: 'ACTIVE' },
    select: {
      id: true,
      user: { select: { name: true, email: true } },
      notificationPreferences: {
        select: { eventType: true, inApp: true, email: true, digest: true },
      },
    },
  })

  return rows.map((row) => ({
    membershipId: row.id,
    name: row.user.name,
    email: row.user.email,
    preferences: row.notificationPreferences,
  }))
}

/** Everyone in the organization holding at least one of the given permissions. */
export async function membershipsWithPermission(
  organizationId: string,
  permissionKeys: string[],
): Promise<string[]> {
  const rows = await getSystemDb().membership.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      roles: {
        some: {
          role: {
            permissions: {
              some: { effect: 'ALLOW', permission: { key: { in: permissionKeys } } },
            },
          },
        },
      },
    },
    select: { id: true },
  })

  return rows.map((row) => row.id)
}

export async function organizationSlug(organizationId: string): Promise<string | null> {
  const org = await getSystemDb().organization.findUnique({
    where: { id: organizationId },
    select: { slug: true },
  })
  return org?.slug ?? null
}
