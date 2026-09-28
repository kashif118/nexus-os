import { describe, expect, it } from 'vitest'

import {
  ageingBucket,
  balanceOf,
  calculateInvoice,
  calculateLine,
  deriveStatus,
  formatQuantity,
  parseQuantity,
  type LineInput,
} from '../calculate'

const line = (overrides: Partial<LineInput> = {}): LineInput => ({
  quantityScaled: 1000,
  quantityScale: 3,
  unitPriceMinor: 10_000n,
  discountBasisPoints: 0,
  taxBasisPoints: 0,
  ...overrides,
})

describe('calculateLine', () => {
  it('multiplies quantity by unit price', () => {
    const result = calculateLine(line({ quantityScaled: 3000, unitPriceMinor: 10_000n }))
    expect(result.lineSubtotalMinor).toBe(30_000n)
    expect(result.lineTotalMinor).toBe(30_000n)
  })

  it('handles a fractional quantity exactly', () => {
    // 2.5 hours at 100.00 = 250.00
    const result = calculateLine(line({ quantityScaled: 2500, unitPriceMinor: 10_000n }))
    expect(result.lineSubtotalMinor).toBe(25_000n)
  })

  it('applies a discount', () => {
    const result = calculateLine(line({ discountBasisPoints: 1000 }))
    expect(result.lineDiscountMinor).toBe(1_000n)
    expect(result.lineTotalMinor).toBe(9_000n)
  })

  it('applies tax to the DISCOUNTED amount, not the gross', () => {
    // 100.00 less 10% = 90.00, then 20% tax = 18.00, total 108.00.
    // Taxing the gross would give 20.00 tax and overcharge the customer.
    const result = calculateLine(line({ discountBasisPoints: 1000, taxBasisPoints: 2000 }))
    expect(result.lineDiscountMinor).toBe(1_000n)
    expect(result.lineTaxMinor).toBe(1_800n)
    expect(result.lineTotalMinor).toBe(10_800n)
  })

  it('rounds half away from zero on an awkward quantity', () => {
    // 0.333 x 100.00 = 33.30
    const result = calculateLine(line({ quantityScaled: 333, unitPriceMinor: 10_000n }))
    expect(result.lineSubtotalMinor).toBe(3_330n)
  })

  it('handles a zero quantity', () => {
    expect(calculateLine(line({ quantityScaled: 0 })).lineTotalMinor).toBe(0n)
  })

  it('handles a zero price', () => {
    const result = calculateLine(line({ unitPriceMinor: 0n, taxBasisPoints: 2000 }))
    expect(result.lineTotalMinor).toBe(0n)
    expect(result.lineTaxMinor).toBe(0n)
  })

  it('charges no tax on a fully discounted line', () => {
    const result = calculateLine(line({ discountBasisPoints: 10_000, taxBasisPoints: 2000 }))
    expect(result.lineTotalMinor).toBe(0n)
    // No tax is due on an amount nobody pays.
    expect(result.lineTaxMinor).toBe(0n)
  })

  it('does not lose precision on a very large line', () => {
    const result = calculateLine(
      line({ quantityScaled: 1_000_000, unitPriceMinor: 99_999_999_999n }),
    )
    expect(result.lineSubtotalMinor).toBe(99_999_999_999_000n)
  })
})

describe('calculateInvoice', () => {
  it('sums a single line', () => {
    expect(calculateInvoice([line()]).totals.totalMinor).toBe(10_000n)
  })

  it('sums several lines', () => {
    const { totals } = calculateInvoice([
      line({ unitPriceMinor: 10_000n }),
      line({ unitPriceMinor: 25_050n }),
    ])
    expect(totals.subtotalMinor).toBe(35_050n)
    expect(totals.totalMinor).toBe(35_050n)
  })

  it('returns zeros for an empty invoice', () => {
    expect(calculateInvoice([]).totals).toEqual({
      subtotalMinor: 0n,
      discountMinor: 0n,
      taxMinor: 0n,
      totalMinor: 0n,
    })
  })

  it('makes the total equal the sum of the printed lines', () => {
    // Three awkward lines that each round; the invoice must agree with itself,
    // or it gets disputed over a penny.
    const lines = [
      line({ quantityScaled: 333, unitPriceMinor: 999n, taxBasisPoints: 1750 }),
      line({ quantityScaled: 777, unitPriceMinor: 1_333n, taxBasisPoints: 1750 }),
      line({ quantityScaled: 1, unitPriceMinor: 7n, taxBasisPoints: 1750 }),
    ]

    const { totals, lines: computed } = calculateInvoice(lines)
    const summed = computed.reduce((total, entry) => total + entry.lineTotalMinor, 0n)

    expect(totals.totalMinor).toBe(summed)
  })

  it('keeps subtotal minus discount plus tax equal to the total', () => {
    const { totals } = calculateInvoice([
      line({ discountBasisPoints: 1500, taxBasisPoints: 2000 }),
      line({ quantityScaled: 2500, discountBasisPoints: 500, taxBasisPoints: 2000 }),
    ])

    expect(totals.subtotalMinor - totals.discountMinor + totals.taxMinor).toBe(totals.totalMinor)
  })
})

describe('balanceOf', () => {
  it('reports what is outstanding', () => {
    expect(balanceOf(10_000n, 3_000n)).toBe(7_000n)
  })

  it('is zero when paid in full', () => {
    expect(balanceOf(10_000n, 10_000n)).toBe(0n)
  })

  it('never goes negative on an overpayment', () => {
    expect(balanceOf(10_000n, 12_000n)).toBe(0n)
  })
})

describe('deriveStatus', () => {
  const dueDate = new Date('2026-06-15T00:00:00.000Z')

  it('leaves a draft alone', () => {
    expect(
      deriveStatus({
        current: 'DRAFT',
        totalMinor: 10_000n,
        amountPaidMinor: 0n,
        dueDate,
        now: new Date('2027-01-01'),
      }),
    ).toBe('DRAFT')
  })

  it('leaves a cancelled invoice alone', () => {
    expect(
      deriveStatus({
        current: 'CANCELLED',
        totalMinor: 10_000n,
        amountPaidMinor: 0n,
        dueDate,
        now: new Date('2027-01-01'),
      }),
    ).toBe('CANCELLED')
  })

  it('is paid once the balance is settled', () => {
    expect(
      deriveStatus({
        current: 'SENT',
        totalMinor: 10_000n,
        amountPaidMinor: 10_000n,
        dueDate,
        now: new Date('2027-01-01'),
      }),
    ).toBe('PAID')
  })

  it('is paid on an overpayment', () => {
    expect(
      deriveStatus({
        current: 'OVERDUE',
        totalMinor: 10_000n,
        amountPaidMinor: 11_000n,
        dueDate,
        now: new Date('2027-01-01'),
      }),
    ).toBe('PAID')
  })

  it('treats a zero-total invoice as settled', () => {
    expect(
      deriveStatus({
        current: 'SENT',
        totalMinor: 0n,
        amountPaidMinor: 0n,
        dueDate,
        now: new Date('2027-01-01'),
      }),
    ).toBe('PAID')
  })

  it('is overdue after the due date with money outstanding', () => {
    expect(
      deriveStatus({
        current: 'SENT',
        totalMinor: 10_000n,
        amountPaidMinor: 0n,
        dueDate,
        now: new Date('2026-06-16T09:00:00.000Z'),
      }),
    ).toBe('OVERDUE')
  })

  it('is NOT overdue on the morning of the due date', () => {
    // An invoice due today is not late at 09:00.
    expect(
      deriveStatus({
        current: 'SENT',
        totalMinor: 10_000n,
        amountPaidMinor: 0n,
        dueDate,
        now: new Date('2026-06-15T09:00:00.000Z'),
      }),
    ).toBe('SENT')
  })

  it('is not overdue while partially paid but still in date', () => {
    expect(
      deriveStatus({
        current: 'SENT',
        totalMinor: 10_000n,
        amountPaidMinor: 5_000n,
        dueDate,
        now: new Date('2026-06-01'),
      }),
    ).toBe('SENT')
  })

  it('recovers from OVERDUE to PAID when payment arrives', () => {
    expect(
      deriveStatus({
        current: 'OVERDUE',
        totalMinor: 10_000n,
        amountPaidMinor: 10_000n,
        dueDate,
        now: new Date('2027-01-01'),
      }),
    ).toBe('PAID')
  })
})

describe('ageingBucket', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')

  it('buckets a future due date as not due', () => {
    expect(ageingBucket(new Date('2026-07-01'), now)).toBe('Not due')
  })

  it('buckets by age', () => {
    expect(ageingBucket(new Date('2026-06-01'), now)).toBe('1–30 days')
    expect(ageingBucket(new Date('2026-05-01'), now)).toBe('31–60 days')
    expect(ageingBucket(new Date('2026-04-01'), now)).toBe('61–90 days')
    expect(ageingBucket(new Date('2025-01-01'), now)).toBe('90+ days')
  })
})

describe('quantity parsing', () => {
  it('parses a whole number', () => {
    expect(parseQuantity('3')).toBe(3000)
  })

  it('parses a fraction', () => {
    expect(parseQuantity('2.5')).toBe(2500)
    expect(parseQuantity('0.125')).toBe(125)
  })

  it('rejects more precision than the scale allows', () => {
    expect(parseQuantity('1.2345')).toBeNull()
  })

  it('rejects rubbish', () => {
    for (const value of ['', 'abc', '-1', '1.2.3']) {
      expect(parseQuantity(value), value).toBeNull()
    }
  })

  it('round-trips through formatQuantity', () => {
    for (const value of ['1', '2.5', '0.125', '100']) {
      expect(formatQuantity(parseQuantity(value)!)).toBe(value)
    }
  })
})
