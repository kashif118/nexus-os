'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import { AiUnavailableError } from './gateway'
import { askSchema, idSchema } from './schema'
import * as service from './service'

export type FormState = ActionResult<{ message?: string; id?: string; answer?: string }> | null

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
        error: { code: 'VALIDATION_ERROR', message: 'Check the highlighted fields.' },
      },
    }
  }

  return { ok: true, data: parsed.data }
}

export async function askAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(askSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.ask(ctx, parsed.data, await getRequestContext())

    revalidatePath(`/${orgSlug}/intelligence`)
    return { ok: true, data: { id: result.conversationId, answer: result.answer } }
  } catch (error) {
    // The one error the UI must phrase specially: there is nothing wrong, the
    // deployment simply has no provider.
    if (error instanceof AiUnavailableError) {
      return {
        ok: false,
        error: {
          code: 'EXTERNAL_SERVICE_ERROR',
          message:
            'AI generation is not configured on this deployment. Insights below are computed from your data and do not need a provider.',
        },
      }
    }
    return toActionResult(error)
  }
}

export async function dismissInsightAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.dismissInsight(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/intelligence`)
    return { ok: true, data: { message: 'Dismissed.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function refreshInsightsAction(
  orgSlug: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.refresh(ctx)
    revalidatePath(`/${orgSlug}/intelligence`)
    return {
      ok: true,
      data: {
        message:
          result.written === 0
            ? 'Nothing needs attention right now.'
            : `${result.written} finding${result.written === 1 ? '' : 's'} updated.`,
      },
    }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteConversationAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteConversation(ctx, parsed.data.id)
    revalidatePath(`/${orgSlug}/intelligence`)
    return { ok: true, data: { message: 'Conversation deleted.' } }
  } catch (error) {
    return toActionResult(error)
  }
}
