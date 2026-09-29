'use server'

import { revalidatePath } from 'next/cache'

import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import { markReadSchema, preferenceSchema } from './schema'
import * as service from './service'

export type FormState = ActionResult<{ message?: string }> | null

function parse<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  formData: FormData,
): { ok: true; data: T } | { ok: false; result: ActionResult<never> } {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))

  if (!parsed.success || parsed.data === undefined) {
    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'That request could not be read.' },
      },
    }
  }

  return { ok: true, data: parsed.data }
}

export async function markReadAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(markReadSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.markRead(ctx, parsed.data.ids)
    revalidatePath(`/${orgSlug}/notifications`)
    return { ok: true, data: {} }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function markAllReadAction(
  orgSlug: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const count = await service.markAllRead(ctx)
    revalidatePath(`/${orgSlug}/notifications`)
    return {
      ok: true,
      data: { message: count === 0 ? 'Nothing unread.' : `${count} marked as read.` },
    }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updatePreferenceAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(preferenceSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.updatePreference(ctx, parsed.data)
    revalidatePath(`/${orgSlug}/settings/notifications`)
    return { ok: true, data: { message: 'Saved.' } }
  } catch (error) {
    return toActionResult(error)
  }
}
