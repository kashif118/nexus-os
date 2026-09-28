'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  budgetSchema,
  categorySchema,
  expenseDecisionSchema,
  expenseSchema,
  idSchema,
  invoiceSchema,
  paymentSchema,
  voidInvoiceSchema,
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

/** Map validated form lines onto the service input shape. */
function toServiceLines(
  lines: Array<{
    description: string
    quantity: number
    unitPrice: bigint
    discountPercent: number
    taxPercent: number
  }>,
) {
  return lines.map((line) => ({
    description: line.description,
    quantityScaled: line.quantity,
    unitPriceMinor: line.unitPrice,
    discountBasisPoints: line.discountPercent,
    taxBasisPoints: line.taxPercent,
  }))
}

/* -------------------------------- invoices -------------------------------- */

export async function createInvoiceAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(invoiceSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    const result = await service.createInvoice(
      ctx,
      { ...parsed.data, lines: toServiceLines(parsed.data.lines) },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/finance/invoices`)
    return ok(`Invoice ${result.number} created.`, result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateInvoiceAction(
  orgSlug: string,
  id: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(invoiceSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    await service.updateInvoice(
      ctx,
      id,
      { ...parsed.data, lines: toServiceLines(parsed.data.lines) },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/finance/invoices/${id}`)
    return ok('Invoice saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function sendInvoiceAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.sendInvoice(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/finance/invoices/${parsed.data.id}`)
    return ok('Invoice issued.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function voidInvoiceAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(voidInvoiceSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.voidInvoice(ctx, parsed.data.id, parsed.data.reason, await getRequestContext())
    revalidatePath(`/${orgSlug}/finance/invoices/${parsed.data.id}`)
    return ok('Invoice voided.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteInvoiceAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteInvoice(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/finance/invoices`)
    return ok('Draft deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function recordPaymentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(paymentSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    await service.recordPayment(
      ctx,
      {
        invoiceId: parsed.data.invoiceId,
        amountMinor: parsed.data.amount,
        method: parsed.data.method,
        receivedAt: parsed.data.receivedAt,
        reference: parsed.data.reference,
      },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/finance/invoices/${parsed.data.invoiceId}`)
    return ok('Payment recorded.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function refreshStatusesAction(
  orgSlug: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const changed = await service.refreshInvoiceStatuses(ctx)
    revalidatePath(`/${orgSlug}/finance/invoices`)
    return ok(changed === 0 ? 'Everything is up to date.' : `${changed} invoice(s) updated.`)
  } catch (error) {
    return toActionResult(error)
  }
}

/* -------------------------------- expenses -------------------------------- */

export async function createExpenseAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(expenseSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    const result = await service.createExpense(
      ctx,
      {
        categoryId: parsed.data.categoryId,
        projectId: parsed.data.projectId,
        vendor: parsed.data.vendor,
        description: parsed.data.description,
        amountMinor: parsed.data.amount,
        taxMinor: parsed.data.tax,
        incurredOn: parsed.data.incurredOn,
        submit: parsed.data.submit,
      },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/finance/expenses`)
    return ok(parsed.data.submit ? 'Expense submitted.' : 'Expense saved as draft.', result.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function submitExpenseAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.submitExpense(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/finance/expenses`)
    return ok('Expense submitted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function decideExpenseAction(
  orgSlug: string,
  approve: boolean,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(expenseDecisionSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.decideExpense(
      ctx,
      { expenseId: parsed.data.expenseId, approve, note: parsed.data.note },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/finance/expenses`)
    return ok(approve ? 'Expense approved.' : 'Expense rejected.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createCategoryAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(categorySchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.createExpenseCategory(ctx, parsed.data.name)
    revalidatePath(`/${orgSlug}/finance/expenses`)
    return ok('Category added.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function createBudgetAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireCtx(orgSlug)
    const parsed = parse(budgetSchema(ctx.org.currency), formData)
    if (!parsed.ok) return parsed.result

    await service.createBudget(
      ctx,
      {
        scopeType: parsed.data.scopeType,
        scopeId: parsed.data.scopeId,
        periodStart: parsed.data.periodStart,
        periodEnd: parsed.data.periodEnd,
        amountMinor: parsed.data.amount,
      },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/finance/budgets`)
    return ok('Budget created.')
  } catch (error) {
    return toActionResult(error)
  }
}
