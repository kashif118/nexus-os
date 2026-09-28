'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireUser } from '@/kernel/auth/guards'
import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { rememberLastOrg } from '@/kernel/tenancy/last-org'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  acceptInvitationSchema,
  createOrganizationSchema,
  inviteMemberSchema,
  membershipIdSchema,
  updateOrganizationSchema,
} from './schema'
import * as rolesService from './roles-service'
import * as service from './service'

/**
 * Organization Server Actions.
 *
 * Every action that touches an existing organization takes `orgSlug` and builds
 * a `Ctx` from it. The slug arrives from the URL, and `requireCtx` verifies an
 * ACTIVE membership before anything else runs — so a forged form post naming
 * another organization resolves to "not found" rather than acting on it.
 *
 * Note what is deliberately absent: no action accepts an `organizationId`. The
 * client never supplies one (docs/PLATFORM.md §H.3, layer 3).
 */

export type FormState = ActionResult<{ message?: string }> | null

function parseFormData<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  formData: FormData,
): { ok: true; data: T } | { ok: false; result: ActionResult<never> } {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))

  if (!parsed.success || parsed.data === undefined) {
    const fields: Record<string, string[]> = {}
    const issues = (parsed.error as { issues?: Array<{ path: PropertyKey[]; message: string }> })
      ?.issues

    for (const issue of issues ?? []) {
      const key = String(issue.path[0] ?? 'form')
      ;(fields[key] ??= []).push(issue.message)
    }

    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Check the highlighted fields.', fields },
      },
    }
  }

  return { ok: true, data: parsed.data }
}

export async function createOrganizationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(createOrganizationSchema, formData)
  if (!parsed.ok) return parsed.result

  let slug: string
  try {
    const session = await requireUser()
    const meta = await getRequestContext()
    const created = await service.createOrganization(parsed.data, { userId: session.user.id }, meta)
    slug = created.slug
    await rememberLastOrg(slug)
  } catch (error) {
    return toActionResult(error)
  }

  redirect(`/${slug}`)
}

export async function updateOrganizationAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(updateOrganizationSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const meta = await getRequestContext()
    await service.updateOrganization(ctx, parsed.data, meta)
    revalidatePath(`/${orgSlug}`, 'layout')
    return { ok: true, data: { message: 'Organization settings saved.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function inviteMemberAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(inviteMemberSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const meta = await getRequestContext()
    await service.inviteMember(ctx, parsed.data, meta)
    revalidatePath(`/${orgSlug}/settings/members`)
    return { ok: true, data: { message: `Invitation sent to ${parsed.data.email}.` } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function revokeInvitationAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const invitationId = String(formData.get('invitationId') ?? '')
  if (!invitationId) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Missing invitation.' } }
  }

  try {
    const ctx = await requireCtx(orgSlug)
    const meta = await getRequestContext()
    await service.revokeInvitation(ctx, invitationId, meta)
    revalidatePath(`/${orgSlug}/settings/members`)
    return { ok: true, data: { message: 'Invitation revoked.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function setMemberStatusAction(
  orgSlug: string,
  status: 'ACTIVE' | 'SUSPENDED',
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(membershipIdSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const meta = await getRequestContext()
    await service.setMemberStatus(ctx, parsed.data.membershipId, status, meta)
    revalidatePath(`/${orgSlug}/settings/members`)
    return {
      ok: true,
      data: { message: status === 'ACTIVE' ? 'Member reinstated.' : 'Member suspended.' },
    }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function removeMemberAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(membershipIdSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const meta = await getRequestContext()
    await service.removeMember(ctx, parsed.data.membershipId, meta)
    revalidatePath(`/${orgSlug}/settings/members`)
    return { ok: true, data: { message: 'Member removed.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function acceptInvitationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(acceptInvitationSchema, formData)
  if (!parsed.ok) return parsed.result

  let slug: string
  try {
    const session = await requireUser()
    const meta = await getRequestContext()
    const result = await service.acceptInvitation(
      parsed.data.token,
      { userId: session.user.id, email: session.user.email },
      meta,
    )
    slug = result.slug
    await rememberLastOrg(slug)
  } catch (error) {
    return toActionResult(error)
  }

  redirect(`/${slug}`)
}

/** Record the organization the user switched into, then navigate. */
export async function switchOrganizationAction(slug: string): Promise<never> {
  await requireUser()
  // Verifies membership; a slug the user does not belong to throws before the
  // cookie is written.
  await requireCtx(slug)
  await rememberLastOrg(slug)
  redirect(`/${slug}`)
}

const roleAssignmentSchema = {
  safeParse(value: unknown) {
    const raw = value as Record<string, unknown>
    const membershipId = typeof raw.membershipId === 'string' ? raw.membershipId.trim() : ''
    const roleId = typeof raw.roleId === 'string' ? raw.roleId.trim() : ''

    if (!membershipId || !roleId || membershipId.length > 64 || roleId.length > 64) {
      return {
        success: false,
        error: { issues: [{ path: ['form'], message: 'Choose a member and a role.' }] },
      }
    }
    return { success: true, data: { membershipId, roleId } }
  },
}

export async function assignRoleAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(roleAssignmentSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const meta = await getRequestContext()
    await rolesService.assignRole(ctx, parsed.data, meta)
    revalidatePath(`/${orgSlug}/settings/members`)
    return { ok: true, data: { message: 'Role assigned.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function unassignRoleAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(roleAssignmentSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const meta = await getRequestContext()
    await rolesService.unassignRole(ctx, parsed.data, meta)
    revalidatePath(`/${orgSlug}/settings/members`)
    return { ok: true, data: { message: 'Role removed.' } }
  } catch (error) {
    return toActionResult(error)
  }
}
