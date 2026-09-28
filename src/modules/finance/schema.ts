import { z } from 'zod'

import { minorUnitExponent, parseAmount } from '@/lib/money'

import { parseQuantity } from './calculate'

export const INVOICE_STATUSES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CARD', 'CASH', 'CHEQUE', 'OTHER'] as const
export const EXPENSE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'REIMBURSED',
] as const
export const BUDGET_SCOPES = ['ORGANIZATION', 'PROJECT', 'DEPARTMENT', 'CATEGORY'] as const

export const INVOICE_SORT_FIELDS = [
  'number',
  'issueDate',
  'dueDate',
  'totalMinor',
  'status',
] as const
export const EXPENSE_SORT_FIELDS = ['incurredOn', 'amountMinor', 'status', 'createdAt'] as const

export type InvoiceSort = (typeof INVOICE_SORT_FIELDS)[number]
export type ExpenseSort = (typeof EXPENSE_SORT_FIELDS)[number]

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))

const optionalId = z
  .string()
  .trim()
  .max(64)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined))

const requiredDate = z
  .string()
  .trim()
  .min(1, 'Enter a date.')
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), 'Enter a valid date.')

/** A money field, validated against the organization currency. */
export const moneyField = (currency: string, { required = false } = {}) =>
  z
    .string()
    .trim()
    .max(32)
    .optional()
    .refine((value) => !required || (value !== undefined && value.length > 0), 'Enter an amount.')
    .refine(
      (value) => !value || value.length === 0 || parseAmount(value, currency) !== null,
      `Enter an amount with at most ${minorUnitExponent(currency)} decimal places.`,
    )
    .transform((value) => (value && value.length > 0 ? (parseAmount(value, currency) ?? 0n) : 0n))

/**
 * A percentage typed as "17.5", stored as basis points.
 *
 * Basis points keep tax and discount in integer arithmetic all the way through
 * the calculation, which is what keeps invoice totals exact.
 */
const percentField = z
  .string()
  .trim()
  .max(10)
  .optional()
  .refine((value) => {
    if (!value || value.length === 0) return true
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
  }, 'Enter a percentage between 0 and 100.')
  .transform((value) => (value && value.length > 0 ? Math.round(Number(value) * 100) : 0))

const quantityField = z
  .string()
  .trim()
  .max(16)
  .optional()
  .refine(
    (value) => !value || value.length === 0 || parseQuantity(value) !== null,
    'Enter a quantity with at most 3 decimal places.',
  )
  .transform((value) => (value && value.length > 0 ? (parseQuantity(value) ?? 1000) : 1000))

export const invoiceLineSchema = (currency: string) =>
  z.object({
    description: z.string().trim().min(1, 'Describe the line.').max(300),
    quantity: quantityField,
    unitPrice: moneyField(currency),
    discountPercent: percentField,
    taxPercent: percentField,
  })

export const invoiceSchema = (currency: string) =>
  z.object({
    companyId: z.string().min(1, 'Choose a client.').max(64),
    contactId: optionalId,
    projectId: optionalId,
    issueDate: requiredDate,
    dueDate: requiredDate,
    notes: optionalText(2000),
    terms: optionalText(2000),
    /**
     * Lines arrive as a JSON array in one field so the form can add and remove
     * rows without a round-trip. Parsed and validated here, never trusted.
     */
    lines: z
      .string()
      .min(1, 'Add at least one line.')
      .transform((value, context) => {
        try {
          const parsed: unknown = JSON.parse(value)
          if (!Array.isArray(parsed) || parsed.length === 0) {
            context.addIssue({ code: 'custom', message: 'Add at least one line.' })
            return z.NEVER
          }
          return parsed
        } catch {
          context.addIssue({ code: 'custom', message: 'The invoice lines could not be read.' })
          return z.NEVER
        }
      })
      .pipe(z.array(invoiceLineSchema(currency)).min(1).max(200)),
  })

export const paymentSchema = (currency: string) =>
  z.object({
    invoiceId: z.string().min(1).max(64),
    amount: moneyField(currency, { required: true }),
    method: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
    receivedAt: requiredDate,
    reference: optionalText(120),
  })

export const expenseSchema = (currency: string) =>
  z.object({
    categoryId: optionalId,
    projectId: optionalId,
    vendor: optionalText(160),
    description: optionalText(1000),
    amount: moneyField(currency, { required: true }),
    tax: moneyField(currency),
    incurredOn: requiredDate,
    submit: z
      .union([z.literal('on'), z.literal('true'), z.literal('')])
      .optional()
      .transform((value) => value === 'on' || value === 'true'),
  })

export const expenseDecisionSchema = z.object({
  expenseId: z.string().min(1).max(64),
  note: optionalText(500),
})

export const budgetSchema = (currency: string) =>
  z.object({
    scopeType: z.enum(BUDGET_SCOPES).default('ORGANIZATION'),
    scopeId: optionalId,
    periodStart: requiredDate,
    periodEnd: requiredDate,
    amount: moneyField(currency, { required: true }),
  })

export const categorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a category name.').max(80),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })

export const voidInvoiceSchema = z.object({
  id: z.string().min(1).max(64),
  reason: optionalText(300),
})
