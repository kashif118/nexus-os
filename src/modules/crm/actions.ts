'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  activityInputSchema,
  closeDealSchema,
  companyInputSchema,
  contactInputSchema,
  convertLeadSchema,
  dealInputSchema,
  entityTagSchema,
  idSchema,
  leadInputSchema,
  moveDealSchema,
  tagInputSchema,
} from './schema'
import * as service from './service'

/**
 * CRM Server Actions.
 *
 * Each action does four things and nothing more: parse with Zod, build a Ctx
 * from the org slug in the URL, call the service, map errors to a typed result.
 * Authorization and business rules live in the service.
 */

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

/* -------------------------------- companies ------------------------------- */

export async function createCompanyAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(companyInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.createCompany(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/companies`)
    return ok('Company created.', result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateCompanyAction(
  orgSlug: string,
  id: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(companyInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.updateCompany(ctx, id, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/companies/${id}`)
    return ok('Company saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteCompanyAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteCompany(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/companies`)
    return ok('Company deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

/* -------------------------------- contacts -------------------------------- */

export async function createContactAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(contactInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.createContact(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/contacts`)
    return ok('Contact created.', result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateContactAction(
  orgSlug: string,
  id: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(contactInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.updateContact(ctx, id, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/contacts/${id}`)
    return ok('Contact saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteContactAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteContact(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/contacts`)
    return ok('Contact deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

/* ---------------------------------- leads --------------------------------- */

export async function createLeadAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(leadInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const result = await service.createLead(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/leads`)
    return ok('Lead created.', result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateLeadAction(
  orgSlug: string,
  id: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(leadInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.updateLead(ctx, id, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/leads/${id}`)
    return ok('Lead saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteLeadAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteLead(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/leads`)
    return ok('Lead deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function convertLeadAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(convertLeadSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)

    // Parsed against the organization currency, so a value with impossible
    // precision is rejected rather than silently truncated.
    const { moneyField } = await import('./schema')
    const valueResult = moneyField(ctx.org.currency).safeParse(parsed.data.dealValue ?? '')
    if (!valueResult.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the highlighted fields.',
          fields: { dealValue: ['Enter a valid amount.'] },
        },
      }
    }

    await service.convertLead(
      ctx,
      {
        leadId: parsed.data.leadId,
        createDeal: parsed.data.createDeal,
        ...(parsed.data.dealTitle ? { dealTitle: parsed.data.dealTitle } : {}),
        dealValueMinor: valueResult.data,
      },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/crm/leads`)
    return ok('Lead converted.')
  } catch (error) {
    return toActionResult(error)
  }
}

/* ---------------------------------- deals --------------------------------- */

export async function createDealAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(dealInputSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    const result = await service.createDeal(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/deals`)
    return ok('Deal created.', result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateDealAction(
  orgSlug: string,
  id: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(dealInputSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    await service.updateDeal(ctx, id, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/deals/${id}`)
    return ok('Deal saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function moveDealAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(moveDealSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.moveDeal(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/pipeline`)
    revalidatePath(`/${orgSlug}/crm/deals/${parsed.data.dealId}`)
    return ok('Deal moved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function closeDealAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(closeDealSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const board = await service.getPipelineBoard(ctx)
    const target = board.pipeline?.stages.find((stage) => stage.type === parsed.data.outcome)
    if (!target) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `This pipeline has no ${parsed.data.outcome.toLowerCase()} stage.`,
        },
      }
    }

    await service.moveDeal(
      ctx,
      { dealId: parsed.data.dealId, stageId: target.id },
      await getRequestContext(),
    )

    if (parsed.data.outcome === 'LOST' && parsed.data.lostReason) {
      await service.updateDeal(
        ctx,
        parsed.data.dealId,
        { lostReason: parsed.data.lostReason },
        await getRequestContext(),
      )
    }

    revalidatePath(`/${orgSlug}/crm/deals/${parsed.data.dealId}`)
    return ok(parsed.data.outcome === 'WON' ? 'Deal marked won.' : 'Deal marked lost.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteDealAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteDeal(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm/deals`)
    return ok('Deal deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

/* -------------------------- activities and tags --------------------------- */

export async function logActivityAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(activityInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.logActivity(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/crm`)
    return ok('Activity logged.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function completeActivityAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.completeActivity(ctx, parsed.data.id)
    revalidatePath(`/${orgSlug}/crm`)
    return ok('Marked complete.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createTagAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(tagInputSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.createTag(ctx, parsed.data)
    revalidatePath(`/${orgSlug}/crm`)
    return ok('Tag created.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function toggleTagAction(
  orgSlug: string,
  attach: boolean,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(entityTagSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    if (attach) await service.attachTag(ctx, parsed.data)
    else await service.detachTag(ctx, parsed.data)

    revalidatePath(`/${orgSlug}/crm`)
    return ok(attach ? 'Tag added.' : 'Tag removed.')
  } catch (error) {
    return toActionResult(error)
  }
}
