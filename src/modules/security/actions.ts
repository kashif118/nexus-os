'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import { apiKeySchema, idSchema, policySchema } from './schema'
import * as service from './service'

/**
 * `plaintext` appears in exactly one place in this system: the response to the
 * action that created the key. It is never stored, never logged, and never
 * returned again.
 */
export type FormState = ActionResult<{ message?: string; plaintext?: string }> | null

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

export async function revokeSessionAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.revokeSession(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/settings/security`)
    return { ok: true, data: { message: 'Session ended.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createApiKeyAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Checkboxes arrive as repeated entries; the schema expects one field.
  const scopes = formData
    .getAll('scope')
    .filter((value): value is string => typeof value === 'string')
  formData.set('scopes', scopes.join(','))

  const parsed = parse(apiKeySchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const key = await service.createApiKey(ctx, parsed.data, await getRequestContext())

    revalidatePath(`/${orgSlug}/settings/security`)
    return {
      ok: true,
      data: {
        message: 'Copy this key now. It cannot be shown again.',
        plaintext: key.plaintext,
      },
    }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function revokeApiKeyAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.revokeApiKey(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/settings/security`)
    return { ok: true, data: { message: 'Key revoked. It stops working immediately.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updatePolicyAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(policySchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.updatePolicy(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/settings/security`)
    return { ok: true, data: { message: 'Security settings saved.' } }
  } catch (error) {
    return toActionResult(error)
  }
}
