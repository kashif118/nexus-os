'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  idSchema,
  milestoneInputSchema,
  milestoneStatusSchema,
  projectInputSchema,
  projectMemberSchema,
  removeMemberSchema,
} from './schema'
import * as service from './service'

/** Project Server Actions. Parse, build Ctx, delegate, map errors. */

export type FormState = ActionResult<{ message?: string; id?: string }> | null

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

const ok = (message: string, id?: string): FormState => ({
  ok: true,
  data: id === undefined ? { message } : { message, id },
})

export async function createProjectAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(projectInputSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    const result = await service.createProject(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects`)
    return ok('Project created.', result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateProjectAction(
  orgSlug: string,
  id: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(projectInputSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    await service.updateProject(ctx, id, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects/${id}`)
    return ok('Project saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteProjectAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteProject(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects`)
    return ok('Project deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function addProjectMemberAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(projectMemberSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.addMember(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects/${parsed.data.projectId}`)
    return ok('Member added.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function removeProjectMemberAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(removeMemberSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.removeMember(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects/${parsed.data.projectId}`)
    return ok('Member removed.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createMilestoneAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(milestoneInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.createMilestone(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects/${parsed.data.projectId}`)
    return ok('Milestone added.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function setMilestoneStatusAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(milestoneStatusSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.setMilestoneStatus(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects`)
    return ok('Milestone updated.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteMilestoneAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteMilestone(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/projects`)
    return ok('Milestone deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}
