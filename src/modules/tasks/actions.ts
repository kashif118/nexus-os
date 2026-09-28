'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  assignTaskSchema,
  checklistItemSchema,
  commentSchema,
  dependencySchema,
  idSchema,
  labelSchema,
  moveTaskSchema,
  removeDependencySchema,
  taskInputSchema,
  taskLabelSchema,
  toggleChecklistSchema,
} from './schema'
import * as service from './service'

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

export async function createTaskAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(taskInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.createTask(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks`)
    return ok('Task created.', result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateTaskAction(
  orgSlug: string,
  id: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(taskInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.updateTask(ctx, id, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks/${id}`)
    return ok('Task saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

/**
 * Board move.
 *
 * Returns a typed result rather than throwing so the board can roll back its
 * optimistic state and show WHY a move was refused — a dependency block is a
 * legitimate answer, not an error.
 */
export async function moveTaskAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(moveTaskSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.moveTask(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks`)
    return ok('Task moved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function assignTaskAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(assignTaskSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.assignTask(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks`)
    return ok('Task assigned.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteTaskAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteTask(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks`)
    return ok('Task deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function addDependencyAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(dependencySchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.addDependency(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks/${parsed.data.taskId}`)
    return ok('Dependency added.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function removeDependencyAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(removeDependencySchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.removeDependency(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks/${parsed.data.taskId}`)
    return ok('Dependency removed.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function addChecklistItemAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(checklistItemSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.addChecklistItem(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks/${parsed.data.taskId}`)
    return ok('Added.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function toggleChecklistItemAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(toggleChecklistSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.toggleChecklistItem(ctx, parsed.data)
    revalidatePath(`/${orgSlug}/tasks/${parsed.data.taskId}`)
    return ok('Updated.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function addCommentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(commentSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.addComment(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/tasks/${parsed.data.taskId}`)
    return ok('Comment posted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function setTaskLabelAction(
  orgSlug: string,
  attach: boolean,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(taskLabelSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.setLabel(ctx, { ...parsed.data, attach })
    revalidatePath(`/${orgSlug}/tasks/${parsed.data.taskId}`)
    return ok(attach ? 'Label added.' : 'Label removed.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createLabelAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(labelSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.createLabel(ctx, parsed.data)
    revalidatePath(`/${orgSlug}/tasks`)
    return ok('Label created.')
  } catch (error) {
    return toActionResult(error)
  }
}
