'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import * as service from './service'

export type FormState = ActionResult<{ message?: string }> | null

const planOf = (formData: FormData): string => String(formData.get('plan') ?? '')

/**
 * Start a checkout.
 *
 * Redirects to the provider. Nothing about the subscription changes here — the
 * plan moves only when a signed webhook says the provider took the money.
 */
export async function startCheckoutAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let url: string

  try {
    const ctx = await requireCtx(orgSlug)
    const session = await service.startCheckout(ctx, planOf(formData), await getRequestContext())
    url = session.url
  } catch (error) {
    return toActionResult(error)
  }

  // Outside the try: `redirect` throws by design, and catching it would turn a
  // successful redirect into an error message.
  redirect(url)
}

export async function openPortalAction(
  orgSlug: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  let url: string

  try {
    const ctx = await requireCtx(orgSlug)
    const session = await service.openBillingPortal(ctx)
    url = session.url
  } catch (error) {
    return toActionResult(error)
  }

  redirect(url)
}

export async function setPlanAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    await service.setPlanManually(ctx, planOf(formData), await getRequestContext())
    revalidatePath(`/${orgSlug}/settings/billing`)
    return { ok: true, data: { message: 'Plan updated.' } }
  } catch (error) {
    return toActionResult(error)
  }
}
