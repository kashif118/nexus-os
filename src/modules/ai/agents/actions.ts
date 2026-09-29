'use server'

import { revalidatePath } from 'next/cache'

import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import { AiUnavailableError } from '../gateway'
import { configureAgentSchema, proposalSchema, runAgentSchema } from './schema'
import * as service from './service'

export type FormState = ActionResult<{ message?: string; id?: string; summary?: string }> | null

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

export async function configureAgentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(configureAgentSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.configureAgent(ctx, parsed.data)
    revalidatePath(`/${orgSlug}/agents`)
    return {
      ok: true,
      data: { message: parsed.data.enabled ? 'Agent switched on.' : 'Agent switched off.' },
    }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function runAgentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(runAgentSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.runAgent(ctx, parsed.data)

    revalidatePath(`/${orgSlug}/agents`)
    return { ok: true, data: { id: result.runId, summary: result.summary } }
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return {
        ok: false,
        error: {
          code: 'EXTERNAL_SERVICE_ERROR',
          message:
            'AI generation is not configured on this deployment, so agents cannot run. Set ANTHROPIC_API_KEY to enable them.',
        },
      }
    }
    return toActionResult(error)
  }
}

export async function acceptProposalAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(proposalSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.acceptProposal(ctx, parsed.data.id)

    revalidatePath(`/${orgSlug}/agents`)
    return result.ok
      ? { ok: true, data: { message: result.message } }
      : { ok: false, error: { code: 'CONFLICT', message: result.message } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function rejectProposalAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(proposalSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.rejectProposal(ctx, parsed.data.id)
    revalidatePath(`/${orgSlug}/agents`)
    return { ok: true, data: { message: 'Rejected.' } }
  } catch (error) {
    return toActionResult(error)
  }
}
