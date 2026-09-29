'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  approvalSchema,
  createWorkflowSchema,
  idSchema,
  manualRunSchema,
  saveDraftSchema,
  statusSchema,
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

export async function createWorkflowAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(createWorkflowSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const workflow = await service.createWorkflow(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/workflows`)
    return ok('Workflow created.', workflow.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function saveDraftAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(saveDraftSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.saveDraft(
      ctx,
      parsed.data.id,
      parsed.data.graph,
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/workflows/${parsed.data.id}`)

    return result.valid
      ? ok('Saved. Ready to publish.')
      : ok(`Saved as a draft. Before publishing: ${result.issues.join(' ')}`)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function publishWorkflowAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.publishWorkflow(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/workflows/${parsed.data.id}`)
    return ok(`Published version ${result.version}. It is now live.`)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function setStatusAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(statusSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.setStatus(ctx, parsed.data.id, parsed.data.status, await getRequestContext())
    revalidatePath(`/${orgSlug}/workflows/${parsed.data.id}`)
    return ok(parsed.data.status === 'ACTIVE' ? 'Workflow activated.' : 'Workflow paused.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteWorkflowAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteWorkflow(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/workflows`)
    return ok('Workflow deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function runWorkflowAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(manualRunSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.runManually(
      ctx,
      {
        workflowId: parsed.data.workflowId,
        payload: parsed.data.payload,
        // A test run is the default; running for real takes an explicit choice.
        dryRun: !parsed.data.live,
      },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/workflows/${parsed.data.workflowId}`)
    return ok(
      `${parsed.data.live ? 'Run' : 'Test run'} finished: ${result.status.toLowerCase()}.`,
      result.runId,
    )
  } catch (error) {
    return toActionResult(error)
  }
}

export async function decideApprovalAction(
  orgSlug: string,
  approve: boolean,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(approvalSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.decideApproval(
      ctx,
      { stepId: parsed.data.stepId, approve },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/workflows`)
    return ok(approve ? 'Approved. The run continues.' : 'Rejected.')
  } catch (error) {
    return toActionResult(error)
  }
}
