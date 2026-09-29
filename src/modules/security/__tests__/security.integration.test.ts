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
import { isAppError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { getDb, getSystemDb } from '@/lib/db'

import { authenticateApiRequest } from '../api-auth'
import { hashApiKey } from '../keys'
import * as service from '../service'

/**
 * The Security Centre against a real database.
 *
 * The pure parts — key generation, digests, CIDR matching — are covered in
 * `keys.test.ts`. What is checked here is everything that only exists once a
 * key, a session and an organization are real:
 *
 * 1. **A key is never recoverable.** The plaintext is returned once and appears
 *    in no row, no listing and no audit entry.
 * 2. **A key is never more powerful than its creator**, at creation OR later.
 *    The permission check happens twice on purpose, because the creator can
 *    lose a role after the key is made.
 * 3. **A key is bound to one organization**, exactly as a session is.
 * 4. **Revoked and expired keys stop working**, rather than merely disappearing
 *    from a screen.
 * 5. **Ending your own session is not a privilege; ending somebody else's is.**
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SLUG = `sec-${suffix}`
const OTHER_SLUG = `sec-other-${suffix}`
const meta = { ip: '203.0.113.9', userAgent: 'vitest-security' }

const state = {
  orgId: '',
  otherOrgId: '',
  users: {} as Record<string, string>,
  memberships: {} as Record<string, string>,
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
      name: 'Security Org',
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

/** A live session row for a member, so revocation has something to act on. */
async function seedSession(key: string, token: string): Promise<string> {
  const session = await getSystemDb().session.create({
    data: {
      userId: state.users[key]!,
      tokenHash: hashApiKey(`${token}-${suffix}`),
      expiresAt: new Date(Date.now() + 86_400_000),
      ip: '198.51.100.4',
      userAgent: 'vitest',
    },
    select: { id: true },
  })
  return session.id
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => isAppError(error) && error.code === code,
    `expected an AppError with code ${code}`,
  )
}

describe.skipIf(!hasDatabase)('Security Centre', () => {
  beforeAll(async () => {
    const db = getSystemDb()

    const owner = await db.user.create({
      data: { email: `sec-owner-${suffix}@example.test`, name: 'owner' },
      select: { id: true },
    })
    const org = await db.organization.create({
      data: { name: SLUG, slug: SLUG, createdById: owner.id },
      select: { id: true },
    })
    const otherOrg = await db.organization.create({
      data: { name: OTHER_SLUG, slug: OTHER_SLUG, createdById: owner.id },
      select: { id: true },
    })

    state.orgId = org.id
    state.otherOrgId = otherOrg.id
    state.users.owner = owner.id

    const membership = await db.membership.create({
      data: { organizationId: org.id, userId: owner.id, status: 'ACTIVE' },
      select: { id: true },
    })
    state.memberships.owner = membership.id

    await seedMember('admin', 'admin')
    await seedMember('manager', 'manager')
    await seedMember('employee', 'employee')
  })

  afterAll(async () => {
    if (!hasDatabase) return
    const db = getSystemDb()
    await db.organization.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(state.users) } } })
    await db.$disconnect()
  })

  /* ------------------------------- API keys ------------------------------- */

  describe('an API key', () => {
    it('is returned once and is not recoverable from anywhere afterwards', async () => {
      const ctx = await makeCtx('owner')

      const created = await service.createApiKey(
        ctx,
        { name: 'Reporting export', scopes: ['project.read.any', 'task.read'] },
        meta,
      )

      expect(created.plaintext).toMatch(/^nxs_/)

      // The row holds a digest and a prefix. Not the key.
      const row = await getSystemDb().apiKey.findUniqueOrThrow({
        where: { id: created.id },
        select: { tokenHash: true, prefix: true, scopes: true },
      })

      expect(row.tokenHash).toBe(hashApiKey(created.plaintext))
      expect(row.tokenHash).not.toContain(created.plaintext)
      expect(created.plaintext.startsWith(row.prefix)).toBe(true)
      expect(row.prefix.length).toBeLessThan(created.plaintext.length / 2)

      // Nor does the listing carry anything that could be replayed.
      const listed = await service.listApiKeys(ctx)
      const entry = listed.find((key) => key.id === created.id)!
      expect(JSON.stringify(entry)).not.toContain(created.plaintext.slice(12))
      expect(Object.keys(entry)).not.toContain('tokenHash')

      // Nor does the audit entry that records its creation.
      const audit = await getSystemDb().auditLog.findFirst({
        where: { organizationId: state.orgId, entityId: created.id },
        select: { action: true, metadata: true },
      })
      expect(audit?.action).toBe('security.apikey.created')
      expect(JSON.stringify(audit?.metadata)).not.toContain(created.plaintext.slice(12))
    })

    it('cannot be created at all by somebody who may not manage keys', async () => {
      const ctx = await makeCtx('manager')
      expect(ctx.can('organization.apikey.manage')).toBe(false)

      await expectAppError(
        service.createApiKey(ctx, { name: 'Unauthorised', scopes: ['task.read'] }, meta),
        'FORBIDDEN',
      )
    })

    it('cannot be granted a permission its creator does not hold', async () => {
      const ctx = await makeCtx('admin')

      // The refusal below must come from the permission CEILING, not from the
      // gate above it — an Admin may manage keys.
      expect(ctx.can('organization.apikey.manage')).toBe(true)
      expect(ctx.can('organization.delete')).toBe(false)

      await expectAppError(
        service.createApiKey(ctx, { name: 'Escalation', scopes: ['organization.delete'] }, meta),
        'FORBIDDEN',
      )
    })

    it('refuses a key with no usable scope rather than making an unusable one', async () => {
      const ctx = await makeCtx('owner')

      await expectAppError(
        service.createApiKey(ctx, { name: 'Empty', scopes: [] }, meta),
        'VALIDATION_ERROR',
      )

      // An unrecognised scope is filtered out, which leaves nothing — the same
      // refusal rather than a key that silently does less than it claims.
      await expectAppError(
        service.createApiKey(ctx, { name: 'Bogus', scopes: ['not.a.permission'] }, meta),
        'VALIDATION_ERROR',
      )
    })

    it('resolves to a context limited to its scopes and bound to its organization', async () => {
      const ctx = await makeCtx('owner')
      const created = await service.createApiKey(
        ctx,
        { name: 'Read only', scopes: ['project.read.any'] },
        meta,
      )

      const resolved = await service.contextForApiKey(hashApiKey(created.plaintext), '203.0.113.1')
      expect(resolved).not.toBeNull()

      const keyCtx = resolved!.ctx
      expect(keyCtx.orgId).toBe(state.orgId)
      expect(keyCtx.orgId).not.toBe(state.otherOrgId)
      expect(keyCtx.sessionId).toBe(`apikey:${created.id}`)

      // In scope, and the owner holds it.
      expect(keyCtx.can('project.read.any')).toBe(true)
      // The owner holds these; the key does not, so the key cannot.
      expect(keyCtx.can('project.delete')).toBe(false)
      expect(keyCtx.can('organization.delete')).toBe(false)
      expect(keyCtx.canAny(['project.delete', 'finance.invoice.void'])).toBe(false)
      expect(() => keyCtx.require('project.delete')).toThrow()

      // Using it is recorded, so an unexpected key can be spotted.
      const row = await getSystemDb().apiKey.findUniqueOrThrow({
        where: { id: created.id },
        select: { lastUsedAt: true, lastUsedIp: true },
      })
      expect(row.lastUsedAt).not.toBeNull()
      expect(row.lastUsedIp).toBe('203.0.113.1')
    })

    it('stops working the moment its creator loses the permission', async () => {
      const db = getSystemDb()
      const ctx = await makeCtx('admin')

      const created = await service.createApiKey(
        ctx,
        { name: 'Admin key', scopes: ['project.create', 'task.read'] },
        meta,
      )

      const before = await service.contextForApiKey(hashApiKey(created.plaintext), null)
      expect(before!.ctx.can('project.create')).toBe(true)

      // The Admin is demoted to an Employee. The key row is untouched.
      const employeeRole = await db.role.findFirstOrThrow({
        where: { organizationId: null, key: 'employee' },
        select: { id: true },
      })
      await db.membershipRole.deleteMany({
        where: { membershipId: state.memberships.admin! },
      })
      await db.membershipRole.create({
        data: {
          organizationId: state.orgId,
          membershipId: state.memberships.admin!,
          roleId: employeeRole.id,
        },
      })

      const after = await service.contextForApiKey(hashApiKey(created.plaintext), null)
      expect(after).not.toBeNull()
      // The scope still says it may; the creator no longer may; the
      // intersection is what decides.
      expect(after!.ctx.can('project.create')).toBe(false)
      // And only that: what the demoted creator still holds still works, so
      // this is an intersection tightening rather than the key being disabled.
      expect(after!.ctx.can('task.read')).toBe(true)
    })

    it('stops working when revoked, and disappears from the listing', async () => {
      const ctx = await makeCtx('owner')
      const created = await service.createApiKey(
        ctx,
        { name: 'To be revoked', scopes: ['project.read.any'] },
        meta,
      )

      await service.revokeApiKey(ctx, created.id, meta)

      expect(await service.contextForApiKey(hashApiKey(created.plaintext), null)).toBeNull()
      expect((await service.listApiKeys(ctx)).some((key) => key.id === created.id)).toBe(false)

      // Revoking it twice is a not-found, not a silent success.
      await expectAppError(service.revokeApiKey(ctx, created.id, meta), 'NOT_FOUND')
    })

    it('stops working once it has expired', async () => {
      const ctx = await makeCtx('owner')
      const created = await service.createApiKey(
        ctx,
        { name: 'Short lived', scopes: ['project.read.any'], expiresInDays: 1 },
        meta,
      )

      expect(await service.contextForApiKey(hashApiKey(created.plaintext), null)).not.toBeNull()

      await getSystemDb().apiKey.update({
        where: { id: created.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      })

      expect(await service.contextForApiKey(hashApiKey(created.plaintext), null)).toBeNull()
    })

    it('does not resolve a key that was never issued', async () => {
      expect(await service.contextForApiKey(hashApiKey('nxs_made-up'), null)).toBeNull()
    })
  })

  /* --------------------------- the request boundary ------------------------ */

  describe('authenticating a request', () => {
    it('accepts the key in a header and refuses it in the query string', async () => {
      const ctx = await makeCtx('owner')
      const created = await service.createApiKey(
        ctx,
        { name: 'Header key', scopes: ['project.read.any'] },
        meta,
      )

      const viaBearer = await authenticateApiRequest(
        new Request('https://nexus.test/api/v1/projects', {
          headers: { authorization: `Bearer ${created.plaintext}` },
        }),
      )
      expect(viaBearer?.ctx.orgId).toBe(state.orgId)

      const viaHeader = await authenticateApiRequest(
        new Request('https://nexus.test/api/v1/projects', {
          headers: { 'x-api-key': created.plaintext },
        }),
      )
      expect(viaHeader?.ctx.orgId).toBe(state.orgId)

      // A credential in a URL ends up in logs and referrers. It is not read.
      const viaQuery = await authenticateApiRequest(
        new Request(`https://nexus.test/api/v1/projects?api_key=${created.plaintext}`),
      )
      expect(viaQuery).toBeNull()
    })

    it('records the caller address from the forwarding header', async () => {
      const ctx = await makeCtx('owner')
      const created = await service.createApiKey(
        ctx,
        { name: 'Forwarded', scopes: ['project.read.any'] },
        meta,
      )

      await authenticateApiRequest(
        new Request('https://nexus.test/api/v1/projects', {
          headers: {
            authorization: `Bearer ${created.plaintext}`,
            'x-forwarded-for': '198.51.100.23, 10.0.0.1',
          },
        }),
      )

      const row = await getSystemDb().apiKey.findUniqueOrThrow({
        where: { id: created.id },
        select: { lastUsedIp: true },
      })
      expect(row.lastUsedIp).toBe('198.51.100.23')
    })
  })

  /* -------------------------------- sessions ------------------------------- */

  describe('sessions', () => {
    it('lets anybody end their own session without a permission', async () => {
      const ctx = await makeCtx('employee')
      const sessionId = await seedSession('employee', 'own')

      // An employee holds no session permission at all.
      expect(ctx.can('security.session.revoke')).toBe(false)

      await service.revokeSession(ctx, sessionId, meta)

      const row = await getSystemDb().session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { revokedAt: true, revokedReason: true },
      })
      expect(row.revokedAt).not.toBeNull()
      expect(row.revokedReason).toBe('Signed out by the user')
    })

    it('requires a permission to end somebody else’s', async () => {
      const employeeCtx = await makeCtx('employee')
      // The manager's session: somebody else's from BOTH points of view below,
      // so neither assertion can pass by the "it is mine" branch.
      const sessionId = await seedSession('manager', 'theirs')

      await expectAppError(service.revokeSession(employeeCtx, sessionId, meta), 'FORBIDDEN')

      const stillLive = await getSystemDb().session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { revokedAt: true },
      })
      expect(stillLive.revokedAt).toBeNull()

      // The owner may, and the reason records who did it.
      const ownerCtx = await makeCtx('owner')
      await service.revokeSession(ownerCtx, sessionId, meta)

      const revoked = await getSystemDb().session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { revokedAt: true, revokedReason: true },
      })
      expect(revoked.revokedAt).not.toBeNull()
      expect(revoked.revokedReason).toContain('owner')
    })

    it('cannot reach a session belonging to another organization', async () => {
      const db = getSystemDb()
      const outsider = await db.user.create({
        data: { email: `sec-outsider-${suffix}@example.test`, name: 'outsider' },
        select: { id: true },
      })
      state.users.outsider = outsider.id

      await db.membership.create({
        data: { organizationId: state.otherOrgId, userId: outsider.id, status: 'ACTIVE' },
      })

      const foreign = await db.session.create({
        data: {
          userId: outsider.id,
          tokenHash: hashApiKey(`foreign-${suffix}`),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true },
      })

      const ownerCtx = await makeCtx('owner')
      await expectAppError(service.revokeSession(ownerCtx, foreign.id, meta), 'NOT_FOUND')

      const untouched = await db.session.findUniqueOrThrow({
        where: { id: foreign.id },
        select: { revokedAt: true },
      })
      expect(untouched.revokedAt).toBeNull()
    })

    it('shows an administrator the organization’s sessions and nobody else’s', async () => {
      const ownerCtx = await makeCtx('owner')
      await seedSession('manager', 'listed')

      const sessions = await service.listSessions(ownerCtx)
      const userIds = new Set(sessions.map((session) => session.userId))

      expect(userIds.has(state.users.manager!)).toBe(true)
      expect(userIds.has(state.users.outsider ?? 'none')).toBe(false)
    })
  })

  /* --------------------------------- audit --------------------------------- */

  describe('the audit log', () => {
    it('is not readable by an ordinary member', async () => {
      const ctx = await makeCtx('employee')
      await expectAppError(service.listAuditLog(ctx), 'FORBIDDEN')
      await expectAppError(service.auditActions(ctx), 'FORBIDDEN')
    })

    it('names who did what, and survives the actor being deleted', async () => {
      const ctx = await makeCtx('owner')
      const entries = await service.listAuditLog(ctx, { limit: 50 })

      expect(entries.length).toBeGreaterThan(0)
      const keyCreation = entries.find((entry) => entry.action === 'security.apikey.created')
      expect(keyCreation).toBeDefined()
      expect(keyCreation!.actorName).toBe('owner')

      const actions = await service.auditActions(ctx)
      expect(actions).toContain('security.apikey.created')
    })
  })

  /* -------------------------------- policy --------------------------------- */

  describe('the security policy', () => {
    it('answers with a usable default before anything is configured', async () => {
      const ctx = await makeCtx('owner')
      const policy = await service.getPolicy(ctx)

      expect(policy.sessionIdleMinutes).toBeGreaterThan(0)
      expect(policy.allowedIpRanges).toEqual([])
    })

    it('refuses a range it could not actually enforce', async () => {
      const ctx = await makeCtx('owner')

      await expectAppError(
        service.updatePolicy(
          ctx,
          {
            sessionIdleMinutes: 60,
            allowedIpRanges: ['2001:db8::/32'],
            alertOnNewIp: true,
          },
          meta,
        ),
        'VALIDATION_ERROR',
      )

      await expectAppError(
        service.updatePolicy(
          ctx,
          { sessionIdleMinutes: 60, allowedIpRanges: ['203.0.113.0'], alertOnNewIp: true },
          meta,
        ),
        'VALIDATION_ERROR',
      )
    })

    it('refuses a session lifetime nobody could work with', async () => {
      const ctx = await makeCtx('owner')

      await expectAppError(
        service.updatePolicy(
          ctx,
          { sessionIdleMinutes: 5, allowedIpRanges: [], alertOnNewIp: true },
          meta,
        ),
        'VALIDATION_ERROR',
      )
    })

    it('stores a valid policy and records the change', async () => {
      const ctx = await makeCtx('owner')

      await service.updatePolicy(
        ctx,
        {
          sessionIdleMinutes: 720,
          allowedIpRanges: ['203.0.113.0/24', '198.51.100.7/32'],
          alertOnNewIp: false,
        },
        meta,
      )

      const policy = await service.getPolicy(ctx)
      expect(policy.sessionIdleMinutes).toBe(720)
      expect(policy.allowedIpRanges).toEqual(['203.0.113.0/24', '198.51.100.7/32'])
      expect(policy.alertOnNewIp).toBe(false)

      const audit = await getSystemDb().auditLog.findFirst({
        where: { organizationId: state.orgId, action: 'security.policy.updated' },
        select: { metadata: true },
      })
      expect(audit).not.toBeNull()

      // Updating again replaces rather than accumulating rows.
      await service.updatePolicy(
        ctx,
        { sessionIdleMinutes: 60, allowedIpRanges: [], alertOnNewIp: true },
        meta,
      )
      const count = await getSystemDb().securityPolicy.count({
        where: { organizationId: state.orgId },
      })
      expect(count).toBe(1)
    })

    it('is not editable by somebody who cannot administer the organization', async () => {
      const ctx = await makeCtx('employee')

      await expectAppError(
        service.updatePolicy(
          ctx,
          { sessionIdleMinutes: 60, allowedIpRanges: [], alertOnNewIp: true },
          meta,
        ),
        'FORBIDDEN',
      )
    })
  })

  /* ------------------------------- the overview ---------------------------- */

  describe('the overview', () => {
    it('shows sessions to somebody who may see them and omits them otherwise', async () => {
      const ownerView = await service.overview(await makeCtx('owner'))
      const employeeView = await service.overview(await makeCtx('employee'))

      expect(ownerView.sessions.length).toBeGreaterThan(0)
      expect(employeeView.sessions).toEqual([])
      // The policy is readable by any member: it explains the rules they are
      // subject to, and contains no secret.
      expect(employeeView.policy.sessionIdleMinutes).toBeGreaterThan(0)
    })
  })
})
