import { writeAuditLog } from '@/kernel/audit/write'
import { daysFromNow, generateToken, hashToken, isExpired } from '@/kernel/auth/tokens'
import { conflict, forbidden, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { absoluteUrl, getMailer } from '@/lib/email/mailer'

import * as repository from './repository'
import * as rolesRepository from './roles-repository'

/**
 * Organization business rules.
 *
 * Every function that operates inside a tenant takes `Ctx` first and uses
 * `ctx.db`, so a query cannot reach another organization even if its `where`
 * clause is wrong. Cross-tenant operations — creating an organization, accepting
 * an invitation — are explicitly named as such.
 */

const INVITATION_TTL_DAYS = 14

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/* ------------------------------- lifecycle -------------------------------- */

export async function listMyOrganizations(userId: string) {
  return repository.listOrganizationsForUser(userId)
}

/**
 * Create an organization with the caller as its first member and owner.
 *
 * Cross-tenant by nature: there is no organization context until this returns.
 */
export async function createOrganization(
  input: {
    name: string
    slug: string
    industry?: string | undefined
    timezone: string
    currency: string
    country?: string | undefined
  },
  actor: { userId: string },
  meta: RequestMeta,
): Promise<{ orgId: string; slug: string }> {
  const existing = await repository.findOrganizationBySlug(input.slug)
  if (existing) {
    throw conflict('That web address is already taken.', {
      slug: ['That web address is already taken.'],
    })
  }

  let created: Awaited<ReturnType<typeof repository.createOrganizationWithOwner>>
  try {
    created = await repository.createOrganizationWithOwner({
      name: input.name,
      slug: input.slug,
      industry: input.industry?.trim() ? input.industry.trim() : null,
      timezone: input.timezone,
      currency: input.currency,
      country: input.country?.trim() ? input.country.trim() : null,
      userId: actor.userId,
    })
  } catch (error) {
    // The unique index is the real guard; the check above is for a better message.
    if (isUniqueConstraintError(error)) {
      throw conflict('That web address is already taken.', {
        slug: ['That web address is already taken.'],
      })
    }
    throw error
  }

  // The creator becomes Owner immediately: an organization must never exist
  // without someone able to administer it.
  await rolesRepository.assignSystemRoleDirect({
    organizationId: created.organization.id,
    membershipId: created.membershipId,
    roleKey: 'owner',
    assignedById: actor.userId,
  })

  await writeAuditLog({
    action: 'organization.created',
    entityType: 'Organization',
    entityId: created.organization.id,
    organizationId: created.organization.id,
    actorId: actor.userId,
    metadata: { slug: created.organization.slug },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { orgId: created.organization.id, slug: created.organization.slug }
}

export async function getOrganization(ctx: Ctx) {
  const organization = await repository.getOrganization(ctx)
  if (!organization) throw notFound('That organization is not available.')
  return organization
}

export async function updateOrganization(
  ctx: Ctx,
  input: {
    name: string
    description?: string | undefined
    industry?: string | undefined
    timezone: string
    currency: string
    country?: string | undefined
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.update')

  await repository.updateOrganization(ctx, {
    name: input.name,
    description: input.description?.trim() ? input.description.trim() : null,
    industry: input.industry?.trim() ? input.industry.trim() : null,
    timezone: input.timezone,
    currency: input.currency,
    country: input.country?.trim() ? input.country.trim() : null,
  })

  await writeAuditLog({
    action: 'organization.updated',
    entityType: 'Organization',
    entityId: ctx.orgId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------- members --------------------------------- */

export async function listMembers(ctx: Ctx) {
  return repository.listMembers(ctx)
}

export async function listPendingInvitations(ctx: Ctx) {
  return repository.listPendingInvitations(ctx)
}

export async function inviteMember(
  ctx: Ctx,
  input: { email: string; title?: string | undefined },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.members.invite')

  // Scoped to this organization, so a member of another tenant is invisible.
  const members = await repository.listMembers(ctx)
  if (members.some((member) => member.user.email === input.email)) {
    throw conflict('That person is already a member.', {
      email: ['That person is already a member.'],
    })
  }

  const pending = await repository.findPendingInvitation(ctx, input.email)
  if (pending) {
    throw conflict('An invitation is already pending for that address.', {
      email: ['An invitation is already pending for that address.'],
    })
  }

  const token = generateToken()
  await repository.createInvitation(ctx, {
    email: input.email,
    tokenHash: hashToken(token),
    expiresAt: daysFromNow(INVITATION_TTL_DAYS),
  })

  const url = absoluteUrl(`/invitations/${encodeURIComponent(token)}`)

  await getMailer().send({
    to: input.email,
    subject: `You have been invited to ${ctx.org.name} on NEXUS OS`,
    text: `${ctx.user.name} invited you to join ${ctx.org.name}.\n\n${url}\n\nThis invitation expires in ${INVITATION_TTL_DAYS} days.`,
  })

  await writeAuditLog({
    action: 'organization.member_invited',
    entityType: 'Invitation',
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { email: input.email },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function revokeInvitation(
  ctx: Ctx,
  invitationId: string,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.members.invite')

  const revoked = await repository.revokeInvitation(ctx, invitationId)
  if (revoked === 0) throw notFound('That invitation is no longer pending.')

  await writeAuditLog({
    action: 'organization.invitation_revoked',
    entityType: 'Invitation',
    entityId: invitationId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Look at an invitation without redeeming it, so the acceptance page can show
 * who is inviting whom before the user commits.
 */
export async function previewInvitation(token: string, userEmail: string) {
  const invitation = await repository.findInvitationByTokenHash(hashToken(token))

  if (!invitation || invitation.organization.deletedAt) {
    throw notFound('That invitation link is not valid.')
  }
  if (invitation.revokedAt) throw validationError('That invitation has been revoked.')
  if (invitation.acceptedAt) throw validationError('That invitation has already been used.')
  if (isExpired(invitation.expiresAt)) throw validationError('That invitation has expired.')

  // Bound to the address it was sent to: forwarding the link does not transfer it.
  if (invitation.email !== userEmail) {
    throw forbidden(
      `This invitation was sent to ${invitation.email}. Sign in as that user to accept it.`,
    )
  }

  return {
    id: invitation.id,
    organizationName: invitation.organization.name,
    organizationSlug: invitation.organization.slug,
    email: invitation.email,
  }
}

/** Redeem an invitation for the signed-in user. Cross-tenant by nature. */
export async function acceptInvitation(
  token: string,
  actor: { userId: string; email: string },
  meta: RequestMeta,
): Promise<{ slug: string }> {
  const preview = await previewInvitation(token, actor.email)
  const invitation = await repository.findInvitationByTokenHash(hashToken(token))
  if (!invitation) throw notFound('That invitation link is not valid.')

  const result = await repository.acceptInvitation({
    invitationId: invitation.id,
    organizationId: invitation.organizationId,
    userId: actor.userId,
    title: null,
  })

  if (!result.accepted) throw validationError('That invitation has already been used.')

  // New members start as Employee — the least-privilege default. An
  // administrator grants more from the members screen.
  if (result.membershipId) {
    await rolesRepository.assignSystemRoleDirect({
      organizationId: invitation.organizationId,
      membershipId: result.membershipId,
      roleKey: 'employee',
      assignedById: null,
    })
  }

  await writeAuditLog({
    action: 'organization.member_joined',
    entityType: 'Membership',
    entityId: result.membershipId,
    organizationId: invitation.organizationId,
    actorId: actor.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { slug: preview.organizationSlug }
}

export async function setMemberStatus(
  ctx: Ctx,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.members.remove')
  await assertNotSelf(ctx, membershipId, 'You cannot change your own membership.')

  const updated = await repository.setMembershipStatus(ctx, membershipId, status)
  if (updated === 0) throw notFound('That member is no longer in this organization.')

  await writeAuditLog({
    action:
      status === 'ACTIVE' ? 'organization.member_reinstated' : 'organization.member_suspended',
    entityType: 'Membership',
    entityId: membershipId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function removeMember(
  ctx: Ctx,
  membershipId: string,
  meta: RequestMeta,
): Promise<void> {
  ctx.require('organization.members.remove')
  await assertNotSelf(ctx, membershipId, 'You cannot remove yourself from the organization.')

  const removed = await repository.removeMembership(ctx, membershipId)
  if (removed === 0) throw notFound('That member is no longer in this organization.')

  await writeAuditLog({
    action: 'organization.member_removed',
    entityType: 'Membership',
    entityId: membershipId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/**
 * Guard against an owner locking the organization out by acting on themselves.
 *
 * The membership is looked up through the scoped client, so an id from another
 * organization simply does not resolve.
 */
async function assertNotSelf(ctx: Ctx, membershipId: string, message: string): Promise<void> {
  const membership = await repository.findMembership(ctx, membershipId)
  if (!membership) throw notFound('That member is no longer in this organization.')
  if (membership.userId === ctx.userId) throw validationError(message)
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/**
 * Where to send a user who has just signed in and named no destination.
 *
 * Their last organization if they are still a member, otherwise any
 * organization, otherwise onboarding. Membership is re-checked here so a stale
 * cookie cannot land someone on a tenant they have left.
 */
export async function resolveLandingPath(userId: string, lastSlug: string | null): Promise<string> {
  const organizations = await repository.listOrganizationsForUser(userId)
  if (organizations.length === 0) return '/organizations/new'

  if (lastSlug && organizations.some((organization) => organization.slug === lastSlug)) {
    return `/${lastSlug}`
  }

  return `/${organizations[0]!.slug}`
}
