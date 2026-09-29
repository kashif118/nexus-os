import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

/**
 * Security reads.
 *
 * Sessions, login events and audit rows are NOT org-scoped tables — a session
 * belongs to a user, who may belong to several organizations. Every query here
 * therefore narrows explicitly to the members of THIS organization, and the
 * narrowing is the first thing each function does rather than a filter applied
 * afterwards.
 */

/** User ids of everyone currently in this organization. */
async function memberUserIds(ctx: Ctx): Promise<string[]> {
  const memberships = await ctx.db.membership.findMany({
    where: { status: 'ACTIVE' },
    select: { userId: true },
  })
  return memberships.map((membership) => membership.userId)
}

/* -------------------------------- sessions --------------------------------- */

export async function listOrganizationSessions(ctx: Ctx, limit = 100) {
  const userIds = await memberUserIds(ctx)
  if (userIds.length === 0) return []

  return getSystemDb().session.findMany({
    where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
    select: {
      id: true,
      userId: true,
      ip: true,
      userAgent: true,
      lastSeenAt: true,
      createdAt: true,
      expiresAt: true,
      user: { select: { name: true, email: true } },
    },
  })
}

export async function listMySessions(ctx: Ctx) {
  return getSystemDb().session.findMany({
    where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      ip: true,
      userAgent: true,
      lastSeenAt: true,
      createdAt: true,
      expiresAt: true,
    },
  })
}

/**
 * Revoke one session, but only if it belongs to a member of this organization.
 *
 * The membership check is what stops an administrator of one organization
 * ending somebody's session in another — a session id is global, and without
 * this the id alone would be enough.
 */
export async function revokeSession(ctx: Ctx, sessionId: string, reason: string): Promise<number> {
  const userIds = await memberUserIds(ctx)
  if (userIds.length === 0) return 0

  const result = await getSystemDb().session.updateMany({
    where: { id: sessionId, userId: { in: userIds }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  })

  return result.count
}

/* ------------------------------ login history ------------------------------ */

export async function listLoginEvents(ctx: Ctx, limit = 100) {
  const userIds = await memberUserIds(ctx)
  if (userIds.length === 0) return []

  return getSystemDb().loginEvent.findMany({
    where: { userId: { in: userIds } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      email: true,
      success: true,
      reason: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  })
}

/* --------------------------------- audit ---------------------------------- */

export async function listAuditLog(
  ctx: Ctx,
  filters: { action?: string | undefined; actorId?: string | undefined; limit?: number } = {},
) {
  return getSystemDb().auditLog.findMany({
    where: {
      // Scoped explicitly: AuditLog has a NULLABLE organizationId by design,
      // because account-level events belong to no organization.
      organizationId: ctx.orgId,
      ...(filters.action ? { action: { startsWith: filters.action } } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: filters.limit ?? 200,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorId: true,
      actorType: true,
      metadata: true,
      ip: true,
      createdAt: true,
    },
  })
}

export async function distinctAuditActions(ctx: Ctx): Promise<string[]> {
  const rows = await getSystemDb().auditLog.findMany({
    where: { organizationId: ctx.orgId },
    distinct: ['action'],
    orderBy: { action: 'asc' },
    take: 200,
    select: { action: true },
  })
  return rows.map((row) => row.action)
}

/** Names for the actor ids in an audit listing, resolved in one query. */
export async function actorNames(ctx: Ctx, actorIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(actorIds.filter(Boolean))]
  if (unique.length === 0) return new Map()

  const users = await getSystemDb().user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  })

  void ctx
  return new Map(users.map((user) => [user.id, user.name]))
}

/* -------------------------------- API keys -------------------------------- */

export async function listApiKeys(ctx: Ctx) {
  return ctx.db.apiKey.findMany({
    where: { revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      lastUsedAt: true,
      lastUsedIp: true,
      expiresAt: true,
      createdAt: true,
      createdBy: { select: { user: { select: { name: true } } } },
    },
  })
}

export async function createApiKey(ctx: Ctx, data: Record<string, unknown>) {
  return ctx.db.apiKey.create({
    data: { ...data, organizationId: ctx.orgId, createdByMembershipId: ctx.membershipId } as never,
    select: { id: true, prefix: true },
  })
}

export async function revokeApiKey(ctx: Ctx, id: string): Promise<number> {
  const result = await ctx.db.apiKey.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count
}

/**
 * Find a key by its digest, across organizations.
 *
 * The system client by necessity: a request presenting a key has no
 * organization yet — the key is what determines it.
 */
export async function findApiKeyByHash(tokenHash: string) {
  return getSystemDb().apiKey.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      organizationId: true,
      scopes: true,
      revokedAt: true,
      expiresAt: true,
      createdByMembershipId: true,
      organization: { select: { slug: true, status: true, deletedAt: true } },
    },
  })
}

export async function touchApiKey(id: string, ip: string | null): Promise<void> {
  await getSystemDb().apiKey.update({
    where: { id },
    data: { lastUsedAt: new Date(), lastUsedIp: ip },
  })
}

/* ------------------------------- policy ----------------------------------- */

export async function findPolicy(ctx: Ctx) {
  return ctx.db.securityPolicy.findFirst({
    select: {
      id: true,
      sessionIdleMinutes: true,
      allowedIpRanges: true,
      alertOnNewIp: true,
      updatedAt: true,
    },
  })
}

export async function upsertPolicy(ctx: Ctx, data: Record<string, unknown>) {
  const existing = await ctx.db.securityPolicy.findFirst({ select: { id: true } })

  if (existing) {
    await ctx.db.securityPolicy.updateMany({ where: { id: existing.id }, data: data as never })
    return existing
  }

  return ctx.db.securityPolicy.create({
    data: { ...data, organizationId: ctx.orgId } as never,
    select: { id: true },
  })
}
