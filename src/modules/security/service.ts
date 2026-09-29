import { writeAuditLog } from '@/kernel/audit/write'
import { forbidden, notFound, validationError } from '@/kernel/errors'
import type { Permission } from '@/kernel/authz/catalogue'
import { ALL_PERMISSIONS } from '@/kernel/authz/catalogue'
import { buildMembershipCtx, type Ctx } from '@/kernel/tenancy/ctx'

import { generateApiKey } from './keys'
import * as repository from './repository'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/**
 * The Security Centre.
 *
 * Everything here is about being able to answer, after the fact, "who did that,
 * from where, and with what". The audit log is the record; this module is how a
 * person reads it and how they end access that should no longer exist.
 */

/* -------------------------------- sessions --------------------------------- */

export async function listSessions(ctx: Ctx) {
  ctx.require('security.session.view')
  return repository.listOrganizationSessions(ctx)
}

/** Your own sessions. No permission needed: they are yours. */
export const listMySessions = (ctx: Ctx) => repository.listMySessions(ctx)

export async function revokeSession(ctx: Ctx, sessionId: string, meta: RequestMeta): Promise<void> {
  const mine = await repository.listMySessions(ctx)
  const isMine = mine.some((session) => session.id === sessionId)

  // Ending your own session needs no permission; ending somebody else's does.
  if (!isMine) ctx.require('security.session.revoke')

  const revoked = await repository.revokeSession(
    ctx,
    sessionId,
    isMine ? 'Signed out by the user' : `Revoked by ${ctx.user.name}`,
  )

  if (revoked === 0) throw notFound('That session is not available.')

  await writeAuditLog({
    action: 'security.session.revoked',
    entityType: 'Session',
    entityId: sessionId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { own: String(isMine) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* ------------------------------ login history ------------------------------ */

export async function listLoginEvents(ctx: Ctx) {
  ctx.require('security.loginhistory.view')
  return repository.listLoginEvents(ctx)
}

/* --------------------------------- audit ---------------------------------- */

export async function listAuditLog(
  ctx: Ctx,
  filters: { action?: string | undefined; limit?: number } = {},
) {
  ctx.require('organization.read')
  // The audit log names what people did. It is deliberately gated on the
  // session-view permission rather than plain membership: "who did what" is
  // exactly the information an attacker inside an organization wants.
  ctx.require('security.loginhistory.view')

  const entries = await repository.listAuditLog(ctx, filters)
  const names = await repository.actorNames(
    ctx,
    entries.map((entry) => entry.actorId ?? '').filter(Boolean),
  )

  return entries.map((entry) => ({
    ...entry,
    actorName: entry.actorId ? (names.get(entry.actorId) ?? 'A former member') : 'System',
  }))
}

export async function auditActions(ctx: Ctx): Promise<string[]> {
  ctx.require('security.loginhistory.view')
  return repository.distinctAuditActions(ctx)
}

/* -------------------------------- API keys -------------------------------- */

export interface CreatedKey {
  id: string
  /** Shown once, at creation. Never retrievable afterwards. */
  plaintext: string
}

export async function listApiKeys(ctx: Ctx) {
  ctx.require('organization.apikey.manage')
  return repository.listApiKeys(ctx)
}

export async function createApiKey(
  ctx: Ctx,
  input: { name: string; scopes: string[]; expiresInDays?: number | undefined },
  meta: RequestMeta,
): Promise<CreatedKey> {
  ctx.require('organization.apikey.manage')

  const scopes = input.scopes.filter((scope): scope is Permission =>
    (ALL_PERMISSIONS as readonly string[]).includes(scope),
  )

  if (scopes.length === 0) {
    throw validationError('Choose at least one permission for this key.', {
      scopes: ['Select what it may do.'],
    })
  }

  // A key cannot exceed its creator. Checked here AND at every request, because
  // the creator may lose a permission after the key is made.
  const beyond = scopes.filter((scope) => !ctx.can(scope))
  if (beyond.length > 0) {
    throw forbidden(`You cannot grant a key permissions you do not hold: ${beyond.join(', ')}.`)
  }

  const generated = generateApiKey()

  const key = await repository.createApiKey(ctx, {
    name: input.name,
    prefix: generated.prefix,
    tokenHash: generated.tokenHash,
    scopes,
    expiresAt:
      input.expiresInDays === undefined
        ? null
        : new Date(Date.now() + input.expiresInDays * 86_400_000),
  })

  await writeAuditLog({
    action: 'security.apikey.created',
    entityType: 'ApiKey',
    entityId: key.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    // The scopes are recorded; the key is not, and never appears in any log.
    metadata: { name: input.name, scopes: scopes.join(',') },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: key.id, plaintext: generated.plaintext }
}

export async function revokeApiKey(ctx: Ctx, id: string, meta: RequestMeta): Promise<void> {
  ctx.require('organization.apikey.manage')

  const revoked = await repository.revokeApiKey(ctx, id)
  if (revoked === 0) throw notFound('That key is not available.')

  await writeAuditLog({
    action: 'security.apikey.revoked',
    entityType: 'ApiKey',
    entityId: id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Resolve a presented API key into a context.
 *
 * The result is a real `Ctx` built from the key's CREATOR, with permissions
 * intersected against the key's scopes. Three consequences:
 *
 * 1. A key is never more powerful than the person who created it, and stops
 *    working for anything they lose access to.
 * 2. A key holder cannot reach another organization, because the context is
 *    org-scoped exactly as a session's would be.
 * 3. Every service behaves identically whether it was called by a person or by
 *    a key — there is no second, weaker authorization path to get wrong.
 */
export async function contextForApiKey(
  plaintextHash: string,
  ip: string | null,
): Promise<{ ctx: Ctx; keyId: string } | null> {
  const key = await repository.findApiKeyByHash(plaintextHash)
  if (!key) return null

  if (key.revokedAt) return null
  if (key.expiresAt && key.expiresAt < new Date()) return null
  if (key.organization.status !== 'ACTIVE' || key.organization.deletedAt) return null
  if (!key.createdByMembershipId) return null

  const creatorCtx = await buildMembershipCtx(key.organizationId, key.createdByMembershipId)
  if (!creatorCtx) return null

  const scopes = new Set(key.scopes)

  const scoped: Ctx = Object.freeze({
    ...creatorCtx,
    sessionId: `apikey:${key.id}`,
    // The intersection: the key's scope AND the creator's live permission.
    can: (permission: Permission) => scopes.has(permission) && creatorCtx.can(permission),
    canAny: (list: readonly Permission[]) =>
      list.some((permission) => scopes.has(permission) && creatorCtx.can(permission)),
    require: (permission: Permission) => {
      if (!scopes.has(permission) || !creatorCtx.can(permission)) {
        throw forbidden('This API key does not have that permission.')
      }
    },
    requireAny: (list: readonly Permission[]) => {
      if (!list.some((permission) => scopes.has(permission) && creatorCtx.can(permission))) {
        throw forbidden('This API key does not have that permission.')
      }
    },
  })

  await repository.touchApiKey(key.id, ip)

  return { ctx: scoped, keyId: key.id }
}

/* --------------------------------- policy --------------------------------- */

export async function getPolicy(ctx: Ctx) {
  ctx.require('organization.read')

  const policy = await repository.findPolicy(ctx)

  // A sensible default rather than null, so the screen never has to render an
  // "unconfigured" state that means the same as the default.
  return (
    policy ?? {
      id: null,
      sessionIdleMinutes: 10_080,
      allowedIpRanges: [] as string[],
      alertOnNewIp: true,
      updatedAt: null,
    }
  )
}

export async function updatePolicy(
  ctx: Ctx,
  input: { sessionIdleMinutes: number; allowedIpRanges: string[]; alertOnNewIp: boolean },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.update')

  if (input.sessionIdleMinutes < 15) {
    throw validationError('A session lifetime under fifteen minutes is unusable in practice.', {
      sessionIdleMinutes: ['Use at least 15 minutes.'],
    })
  }

  const invalid = input.allowedIpRanges.filter((range) => !isCidr(range))
  if (invalid.length > 0) {
    throw validationError(`Not a valid address range: ${invalid.join(', ')}`, {
      allowedIpRanges: ['Use CIDR notation, for example 203.0.113.0/24.'],
    })
  }

  await repository.upsertPolicy(ctx, {
    sessionIdleMinutes: input.sessionIdleMinutes,
    allowedIpRanges: input.allowedIpRanges,
    alertOnNewIp: input.alertOnNewIp,
  })

  await writeAuditLog({
    action: 'security.policy.updated',
    entityType: 'SecurityPolicy',
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: {
      sessionIdleMinutes: String(input.sessionIdleMinutes),
      ranges: String(input.allowedIpRanges.length),
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * IPv4 CIDR validation.
 *
 * Deliberately strict and deliberately limited to IPv4: accepting something
 * this code cannot actually enforce would be worse than refusing it. IPv6
 * support is a change to this function and the matcher that uses it.
 */
export function isCidr(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value.trim())
  if (!match) return false

  const octets = [match[1], match[2], match[3], match[4]].map(Number)
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return false

  const bits = Number(match[5])
  return bits >= 0 && bits <= 32
}

/** Whether an address falls inside any of the ranges. Empty list allows all. */
export function ipAllowed(ip: string | null, ranges: string[]): boolean {
  if (ranges.length === 0) return true
  // An unknown address cannot be proved to be inside an allowlist, and an
  // allowlist that fails open is not an allowlist.
  if (!ip) return false

  const address = toIpv4Number(ip)
  if (address === null) return false

  return ranges.some((range) => {
    const [base, bitsText] = range.split('/')
    const network = toIpv4Number(base ?? '')
    const bits = Number(bitsText)
    if (network === null || Number.isNaN(bits)) return false

    if (bits === 0) return true
    const mask = (0xffffffff << (32 - bits)) >>> 0
    return (address & mask) === (network & mask)
  })
}

function toIpv4Number(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null

  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = (value << 8) | octet
  }

  return value >>> 0
}

export async function overview(ctx: Ctx) {
  const [sessions, policy] = await Promise.all([
    ctx.can('security.session.view') ? repository.listOrganizationSessions(ctx, 25) : [],
    getPolicy(ctx),
  ])

  return { sessions, policy }
}
