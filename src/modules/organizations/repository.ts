import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

/**
 * Data access for organizations and membership.
 *
 * This module is unusual, and deliberately so: it is one of the sanctioned
 * cross-tenant surfaces (docs/PLATFORM.md §H.4). Creating an organization,
 * listing the organizations a user belongs to and accepting an invitation all
 * happen before — or across — any single tenant, so they use the system client.
 *
 * Functions that operate INSIDE one organization take a `Ctx` and use its
 * org-scoped client, so they cannot reach another tenant rows.
 */

/* ------------------------------ cross-tenant ------------------------------ */

/** Organizations the user is an active member of, for the switcher. */
export async function listOrganizationsForUser(userId: string) {
  const memberships = await getSystemDb().membership.findMany({
    where: { userId, status: 'ACTIVE', organization: { deletedAt: null, status: 'ACTIVE' } },
    orderBy: { organization: { name: 'asc' } },
    select: {
      id: true,
      organization: { select: { id: true, slug: true, name: true, logoUrl: true } },
    },
  })

  return memberships.map((membership) => ({
    membershipId: membership.id,
    ...membership.organization,
  }))
}

export async function findOrganizationBySlug(slug: string) {
  return getSystemDb().organization.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, slug: true },
  })
}

/**
 * Create an organization and its first membership in one transaction.
 *
 * Atomic on purpose: an organization with no members would be unreachable and
 * undeletable through the UI.
 */
export async function createOrganizationWithOwner(input: {
  name: string
  slug: string
  industry: string | null
  timezone: string
  currency: string
  country: string | null
  userId: string
}) {
  return getSystemDb().$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.name,
        slug: input.slug,
        industry: input.industry,
        timezone: input.timezone,
        currency: input.currency,
        country: input.country,
        createdById: input.userId,
      },
      select: { id: true, slug: true, name: true },
    })

    const membership = await tx.membership.create({
      data: {
        organizationId: organization.id,
        userId: input.userId,
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
      select: { id: true },
    })

    return { organization, membershipId: membership.id }
  })
}

/** Find a live invitation by token hash. Cross-tenant: the recipient has no org yet. */
export async function findInvitationByTokenHash(tokenHash: string) {
  return getSystemDb().invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      organizationId: true,
      email: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      organization: { select: { id: true, slug: true, name: true, deletedAt: true } },
    },
  })
}

/**
 * Redeem an invitation: mark it accepted and create or reactivate the membership.
 *
 * The `acceptedAt: null` predicate makes redemption atomic, so a token cannot be
 * used twice even under concurrent requests.
 */
export async function acceptInvitation(input: {
  invitationId: string
  organizationId: string
  userId: string
  title: string | null
}): Promise<{ accepted: boolean; membershipId: string | null }> {
  return getSystemDb().$transaction(async (tx) => {
    const claimed = await tx.invitation.updateMany({
      where: { id: input.invitationId, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    })
    if (claimed.count !== 1) return { accepted: false, membershipId: null }

    const membership = await tx.membership.upsert({
      where: {
        organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
      },
      create: {
        organizationId: input.organizationId,
        userId: input.userId,
        status: 'ACTIVE',
        joinedAt: new Date(),
        title: input.title,
      },
      update: { status: 'ACTIVE', joinedAt: new Date() },
      select: { id: true },
    })

    return { accepted: true, membershipId: membership.id }
  })
}

/* --------------------------- inside one tenant ---------------------------- */

export async function getOrganization(ctx: Ctx) {
  return ctx.db.organization.findFirst({
    where: { id: ctx.orgId },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      industry: true,
      timezone: true,
      currency: true,
      country: true,
      logoUrl: true,
      createdAt: true,
    },
  })
}

export async function updateOrganization(
  ctx: Ctx,
  data: {
    name: string
    description: string | null
    industry: string | null
    timezone: string
    currency: string
    country: string | null
  },
) {
  // `Organization` is not itself a tenant model (it has no organizationId
  // column), so the id predicate from Ctx is what scopes this write.
  await ctx.db.organization.update({ where: { id: ctx.orgId }, data })
}

export async function listMembers(ctx: Ctx) {
  return ctx.db.membership.findMany({
    where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      status: true,
      title: true,
      joinedAt: true,
      createdAt: true,
      userId: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  })
}

export async function countActiveMembers(ctx: Ctx): Promise<number> {
  return ctx.db.membership.count({ where: { status: 'ACTIVE' } })
}

export async function findMembership(ctx: Ctx, membershipId: string) {
  return ctx.db.membership.findFirst({
    where: { id: membershipId },
    select: { id: true, userId: true, status: true, user: { select: { email: true, name: true } } },
  })
}

export async function setMembershipStatus(
  ctx: Ctx,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED',
) {
  const result = await ctx.db.membership.updateMany({
    where: { id: membershipId },
    data: { status },
  })
  return result.count
}

export async function removeMembership(ctx: Ctx, membershipId: string) {
  const result = await ctx.db.membership.deleteMany({ where: { id: membershipId } })
  return result.count
}

export async function listPendingInvitations(ctx: Ctx) {
  return ctx.db.invitation.findMany({
    where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, createdAt: true, expiresAt: true },
  })
}

export async function findPendingInvitation(ctx: Ctx, email: string) {
  return ctx.db.invitation.findFirst({
    where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  })
}

export async function createInvitation(
  ctx: Ctx,
  input: { email: string; tokenHash: string; expiresAt: Date },
) {
  return ctx.db.invitation.create({
    data: {
      // Supplied explicitly because the generated types require it; the
      // org-scoped client rejects any value other than ctx.orgId.
      organizationId: ctx.orgId,
      email: input.email,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      invitedById: ctx.userId,
    },
    select: { id: true },
  })
}

export async function revokeInvitation(ctx: Ctx, invitationId: string) {
  const result = await ctx.db.invitation.updateMany({
    where: { id: invitationId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count
}

export async function findMembershipForUser(ctx: Ctx, userId: string) {
  return ctx.db.membership.findFirst({ where: { userId }, select: { id: true, status: true } })
}
