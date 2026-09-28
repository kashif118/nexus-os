import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'

import { getSession } from '@/kernel/auth/session'
import {
  can,
  canAny,
  grantedFrom,
  require as requirePermission,
  requireAny,
  resolveScope,
  type PermissionSet,
  type ScopeDecision,
} from '@/kernel/authz/can'
import type { Permission } from '@/kernel/authz/catalogue'
import { loadPermissions } from '@/kernel/authz/load'
import { notFound as notFoundError, unauthenticated } from '@/kernel/errors'
import { getDb, getSystemDb, type OrgScopedClient } from '@/lib/db'

/**
 * Organization context (docs/PLATFORM.md §G.4).
 *
 * `Ctx` answers "who is calling, in which organization, and what may they do".
 * Every service function takes it as its first parameter, and nothing reads or
 * writes tenant data without one.
 *
 * Authorization lives on the context rather than beside it so that a service
 * cannot accidentally check permissions for a different actor than the one whose
 * data it is about to touch.
 */

export interface Ctx {
  readonly userId: string
  readonly sessionId: string
  readonly orgId: string
  readonly orgSlug: string
  readonly membershipId: string
  readonly isOwner: boolean

  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerifiedAt: Date | null
  }
  readonly org: {
    readonly id: string
    readonly slug: string
    readonly name: string
    readonly logoUrl: string | null
    readonly timezone: string
    readonly currency: string
  }

  /** Roles held in this organization, highest priority first. */
  readonly roles: ReadonlyArray<{ key: string; name: string; priority: number }>
  readonly permissions: PermissionSet

  /** True if the actor holds the permission. For conditional data, not security. */
  can(permission: Permission): boolean
  canAny(permissions: readonly Permission[]): boolean
  /** Throws ForbiddenError unless the actor holds the permission. */
  require(permission: Permission): void
  requireAny(permissions: readonly Permission[]): void
  /** Resolve an `.any` / `.own` pair into a query scope. */
  scope(anyPermission: Permission, ownPermission: Permission): ScopeDecision
  /** The subset of `candidates` held, for the client permission snapshot. */
  granted(candidates: readonly Permission[]): Permission[]

  /** The org-scoped Prisma client. Repositories must use only this. */
  readonly db: OrgScopedClient
}

/**
 * Resolve the context for an organization slug, or null.
 *
 * Memoised per request, so a layout, its pages and any action in the same render
 * share one round-trip.
 *
 * A non-member gets null, which callers surface as 404 — never 403. Confirming
 * that an organization exists is itself a disclosure (§G.4 step 4).
 */
export const loadCtx = cache(async (orgSlug: string): Promise<Ctx | null> => {
  const session = await getSession()
  if (!session) return null

  // Cross-tenant by necessity: resolving a slug to an organization happens
  // before any organization is known (docs/PLATFORM.md §H.4).
  const membership = await getSystemDb().membership.findFirst({
    where: {
      status: 'ACTIVE',
      userId: session.user.id,
      organization: { slug: orgSlug, status: 'ACTIVE', deletedAt: null },
    },
    select: {
      id: true,
      organization: {
        select: {
          id: true,
          slug: true,
          name: true,
          logoUrl: true,
          timezone: true,
          currency: true,
          createdById: true,
        },
      },
    },
  })

  if (!membership) return null

  const { organization } = membership
  const isOwner = organization.createdById === session.user.id

  const { permissions, roles } = await loadPermissions({
    membershipId: membership.id,
    organizationId: organization.id,
    isOwner,
  })

  return Object.freeze({
    userId: session.user.id,
    sessionId: session.sessionId,
    orgId: organization.id,
    orgSlug: organization.slug,
    membershipId: membership.id,
    isOwner,

    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerifiedAt: session.user.emailVerifiedAt,
    },
    org: {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      logoUrl: organization.logoUrl,
      timezone: organization.timezone,
      currency: organization.currency,
    },

    roles,
    permissions,

    can: (permission: Permission) => can(permissions, permission),
    canAny: (candidates: readonly Permission[]) => canAny(permissions, candidates),
    require: (permission: Permission) => requirePermission(permissions, permission),
    requireAny: (candidates: readonly Permission[]) => requireAny(permissions, candidates),
    scope: (anyPermission: Permission, ownPermission: Permission) =>
      resolveScope(permissions, anyPermission, ownPermission),
    granted: (candidates: readonly Permission[]) => grantedFrom(permissions, candidates),

    db: getDb(organization.id),
  })
})

/**
 * Require a context inside a Server Action. Throws typed errors the action
 * wrapper turns into a result.
 */
export async function requireCtx(orgSlug: string): Promise<Ctx> {
  const session = await getSession()
  if (!session) throw unauthenticated()

  const ctx = await loadCtx(orgSlug)
  // Not a member: indistinguishable from "no such organization".
  if (!ctx) throw notFoundError('That organization is not available.')
  return ctx
}

/**
 * Require a context inside a page or layout.
 *
 * Signed out redirects to sign-in; signed in but not a member renders 404, so
 * probing slugs reveals nothing about which organizations exist.
 */
export async function requireCtxPage(orgSlug: string, returnTo?: string): Promise<Ctx> {
  const session = await getSession()
  if (!session) {
    redirect(returnTo ? `/sign-in?next=${encodeURIComponent(returnTo)}` : '/sign-in')
  }

  const ctx = await loadCtx(orgSlug)
  if (!ctx) notFound()
  return ctx
}
