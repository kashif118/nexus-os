'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  departmentSchema,
  memberSkillSchema,
  profileSchema,
  removeTeamMemberSchema,
  skillSchema,
  teamMemberSchema,
  teamSchema,
} from './schema'
import * as service from './service'

export type FormState = ActionResult<{ message?: string }> | null

function parse<T>(
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

const ok = (message: string): FormState => ({ ok: true, data: { message } })

export async function saveProfileAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(profileSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    await service.upsertProfile(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/people/${parsed.data.membershipId}`)
    return ok('Profile saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createTeamAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(teamSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.createTeam(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/people/teams`)
    return ok('Team created.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function addTeamMemberAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(teamMemberSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.addTeamMember(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/people/teams`)
    return ok('Added to team.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function removeTeamMemberAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(removeTeamMemberSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.removeTeamMember(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/people/teams`)
    return ok('Removed from team.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createDepartmentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(departmentSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.createDepartment(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/people/departments`)
    return ok('Department created.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createSkillAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(skillSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.createSkill(ctx, parsed.data)
    revalidatePath(`/${orgSlug}/people/skills`)
    return ok('Skill added.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function setMemberSkillAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(memberSkillSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.setMemberSkill(ctx, parsed.data)
    revalidatePath(`/${orgSlug}/people/${parsed.data.membershipId}`)
    return ok('Skill updated.')
  } catch (error) {
    return toActionResult(error)
  }
}
