import { divideRounded, percentOf } from '@/lib/money'

/**
 * Invoice arithmetic.
 *
 * Pure, integer-only, and the single source of truth for what an invoice is
 * worth. The client never sends a total — it sends line items, and this
 * computes the rest — because a total supplied by the caller is a total an
 * attacker can choose.
 *
 * Every value is in minor units. Quantities arrive as scaled integers (2.5 is
 * `2500` with scale `3`) so that a fractional quantity never becomes a float.
 *
 * Order of operations matters and is fixed here: discount comes off the line
 * subtotal, and tax applies to the DISCOUNTED amount. Applying tax first would
 * overcharge tax on money the customer never pays.
 */

export interface LineInput {
  quantityScaled: number
  quantityScale: number
  unitPriceMinor: bigint
  discountBasisPoints: number
  taxBasisPoints: number
}

export interface LineTotals {
  lineSubtotalMinor: bigint
  lineDiscountMinor: bigint
  lineTaxMinor: bigint
  lineTotalMinor: bigint
}

export interface InvoiceTotals {
  subtotalMinor: bigint
  discountMinor: bigint
  taxMinor: bigint
  totalMinor: bigint
}

/** Compute one line. */
export function calculateLine(line: LineInput): LineTotals {
  const divisor = 10n ** BigInt(line.quantityScale)

  // quantity × unit price, rounded to the minor unit.
  const lineSubtotalMinor = divideRounded(
    BigInt(line.quantityScaled) * line.unitPriceMinor,
    divisor,
  )

  const lineDiscountMinor = percentOf(lineSubtotalMinor, BigInt(line.discountBasisPoints))
  const discounted = lineSubtotalMinor - lineDiscountMinor

  // Tax on the discounted amount, not the gross.
  const lineTaxMinor = percentOf(discounted, BigInt(line.taxBasisPoints))

  return {
    lineSubtotalMinor,
    lineDiscountMinor,
    lineTaxMinor,
    lineTotalMinor: discounted + lineTaxMinor,
  }
}

/**
 * Sum lines into an invoice total.
 *
 * Totals are summed from the ALREADY-ROUNDED line values rather than recomputed
 * from raw inputs, so the invoice total always equals the sum of what is printed
 * on the lines. Recomputing would let the total disagree with its own lines by a
 * minor unit, which is exactly the discrepancy that gets an invoice disputed.
 */
export function calculateInvoice(lines: readonly LineInput[]): {
  totals: InvoiceTotals
  lines: LineTotals[]
} {
  const computed = lines.map(calculateLine)

  const totals = computed.reduce<InvoiceTotals>(
    (accumulator, line) => ({
      subtotalMinor: accumulator.subtotalMinor + line.lineSubtotalMinor,
      discountMinor: accumulator.discountMinor + line.lineDiscountMinor,
      taxMinor: accumulator.taxMinor + line.lineTaxMinor,
      totalMinor: accumulator.totalMinor + line.lineTotalMinor,
    }),
    { subtotalMinor: 0n, discountMinor: 0n, taxMinor: 0n, totalMinor: 0n },
  )

  return { totals, lines: computed }
}

/** Outstanding balance. Never negative: an overpayment shows as a zero balance. */
export function balanceOf(totalMinor: bigint, amountPaidMinor: bigint): bigint {
  const balance = totalMinor - amountPaidMinor
  return balance > 0n ? balance : 0n
}

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED'

/**
 * The status an invoice should have, given its facts.
 *
 * Derived rather than set by hand so "overdue" cannot be wrong: an invoice is
 * overdue because its due date passed and money is outstanding, not because
 * somebody remembered to change a dropdown.
 *
 * DRAFT and CANCELLED are terminal decisions a person makes, so they are left
 * alone.
 */
export function deriveStatus(input: {
  current: InvoiceStatus
  totalMinor: bigint
  amountPaidMinor: bigint
  dueDate: Date
  now?: Date
}): InvoiceStatus {
  if (input.current === 'DRAFT' || input.current === 'CANCELLED') return input.current

  const now = input.now ?? new Date()

  // Paid in full — including the zero-total case, which is settled by definition.
  if (input.amountPaidMinor >= input.totalMinor) return 'PAID'

  // Compared by day, not timestamp: an invoice due today is not overdue at 09:00.
  const dueEndOfDay = new Date(input.dueDate)
  dueEndOfDay.setUTCHours(23, 59, 59, 999)

  if (now > dueEndOfDay) return 'OVERDUE'

  return 'SENT'
}

/** Ageing bucket for the receivables report. */
export function ageingBucket(dueDate: Date, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000)
  if (days <= 0) return 'Not due'
  if (days <= 30) return '1–30 days'
  if (days <= 60) return '31–60 days'
  if (days <= 90) return '61–90 days'
  return '90+ days'
}

/** Parse a quantity string ("2.5") into a scaled integer. */
export function parseQuantity(input: string, scale = 3): number | null {
  const cleaned = input.trim().replace(/[\s,_]/g, '')
  if (cleaned === '') return null

  const match = /^(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!match) return null

  const [, whole = '', fraction = ''] = match
  if (whole === '' && fraction === '') return null
  if (fraction.length > scale) return null

  const scaled = Number(`${whole || '0'}${fraction.padEnd(scale, '0')}`)
  return Number.isSafeInteger(scaled) && scaled >= 0 ? scaled : null
}

/** Scaled quantity back to a display string. */
export function formatQuantity(quantityScaled: number, scale = 3): string {
  const divisor = 10 ** scale
  const whole = Math.floor(quantityScaled / divisor)
  const fraction = String(quantityScaled % divisor)
    .padStart(scale, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}
