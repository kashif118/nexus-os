import { describe, expect, it } from 'vitest'

import {
  allocate,
  assertSameCurrency,
  divideRounded,
  formatMoney,
  minorUnitExponent,
  multiplyMoney,
  parseAmount,
  percentOf,
  sumMoney,
  toDecimalString,
} from '../money'

describe('minor unit exponents', () => {
  it('defaults to two decimals', () => {
    expect(minorUnitExponent('USD')).toBe(2)
    expect(minorUnitExponent('eur')).toBe(2)
  })

  it('knows zero-decimal currencies', () => {
    expect(minorUnitExponent('JPY')).toBe(0)
  })

  it('knows three-decimal currencies', () => {
    expect(minorUnitExponent('KWD')).toBe(3)
  })
})

describe('parseAmount', () => {
  it('parses a plain decimal', () => {
    expect(parseAmount('1234.56', 'USD')).toBe(123456n)
  })

  it('parses thousands separators and spaces', () => {
    expect(parseAmount('1,234.56', 'USD')).toBe(123456n)
    expect(parseAmount(' 1 234.56 ', 'USD')).toBe(123456n)
  })

  it('pads a short fraction', () => {
    expect(parseAmount('10.5', 'USD')).toBe(1050n)
    expect(parseAmount('10', 'USD')).toBe(1000n)
  })

  it('respects the currency exponent', () => {
    expect(parseAmount('1000', 'JPY')).toBe(1000n)
    expect(parseAmount('1.234', 'KWD')).toBe(1234n)
  })

  it('rejects more precision than the currency has', () => {
    expect(parseAmount('1.999', 'USD')).toBeNull()
    expect(parseAmount('1.5', 'JPY')).toBeNull()
  })

  it('handles negatives', () => {
    expect(parseAmount('-42.50', 'USD')).toBe(-4250n)
  })

  it('rejects rubbish rather than silently storing zero', () => {
    for (const input of ['', '   ', 'abc', '1.2.3', '$10', '1e5']) {
      expect(parseAmount(input, 'USD'), input).toBeNull()
    }
  })

  it('does not lose precision on large amounts', () => {
    // Beyond Number.MAX_SAFE_INTEGER in minor units.
    expect(parseAmount('123456789012345.67', 'USD')).toBe(12345678901234567n)
  })
})

describe('toDecimalString', () => {
  it('round-trips with parseAmount', () => {
    for (const input of ['0.00', '1.00', '1234.56', '-42.50', '0.01']) {
      const minor = parseAmount(input, 'USD')!
      expect(toDecimalString(minor, 'USD')).toBe(input)
    }
  })

  it('pads small amounts', () => {
    expect(toDecimalString(5n, 'USD')).toBe('0.05')
    expect(toDecimalString(0n, 'USD')).toBe('0.00')
  })

  it('omits the point for zero-decimal currencies', () => {
    expect(toDecimalString(1000n, 'JPY')).toBe('1000')
  })
})

describe('arithmetic', () => {
  it('sums exactly where floats would drift', () => {
    // 0.1 + 0.2 in cents is exactly 30, which is the whole point.
    expect(sumMoney([10n, 20n])).toBe(30n)
  })

  it('sums a long list without drift', () => {
    const amounts = Array.from({ length: 1000 }, () => 1n)
    expect(sumMoney(amounts)).toBe(1000n)
  })

  it('multiplies by a fractional quantity', () => {
    // 2.5 hours at 100.00 per hour = 250.00
    expect(multiplyMoney(10_000n, 25n, 1)).toBe(25_000n)
  })

  it('rounds half away from zero', () => {
    expect(divideRounded(5n, 2n)).toBe(3n)
    expect(divideRounded(-5n, 2n)).toBe(-3n)
    expect(divideRounded(4n, 2n)).toBe(2n)
  })

  it('refuses division by zero', () => {
    expect(() => divideRounded(1n, 0n)).toThrow()
  })

  it('applies a percentage in basis points', () => {
    expect(percentOf(10_000n, 2000n)).toBe(2000n) // 20% of 100.00
    expect(percentOf(999n, 2000n)).toBe(200n) // rounds 199.8 to 200
  })
})

describe('allocate', () => {
  it('splits evenly when it divides cleanly', () => {
    expect(allocate(300n, [1n, 1n, 1n])).toEqual([100n, 100n, 100n])
  })

  it('distributes the remainder so the parts reconcile', () => {
    const shares = allocate(100n, [1n, 1n, 1n])
    expect(shares).toEqual([34n, 33n, 33n])
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n)
  })

  it('respects weights', () => {
    const shares = allocate(1000n, [3n, 1n])
    expect(shares).toEqual([750n, 250n])
  })

  it('always reconciles to the original amount', () => {
    for (const amount of [1n, 7n, 99n, 1234n, 100_001n]) {
      const shares = allocate(amount, [5n, 3n, 2n, 1n])
      expect(
        shares.reduce((a, b) => a + b, 0n),
        String(amount),
      ).toBe(amount)
    }
  })

  it('refuses a zero total weight', () => {
    expect(() => allocate(100n, [0n, 0n])).toThrow()
  })
})

describe('formatMoney', () => {
  it('formats with the currency symbol', () => {
    expect(formatMoney(123456n, 'USD')).toBe('$1,234.56')
  })

  it('formats zero-decimal currencies without a fraction', () => {
    expect(formatMoney(1000n, 'JPY')).toBe('¥1,000')
  })

  it('formats negatives', () => {
    expect(formatMoney(-4250n, 'USD')).toContain('42.50')
  })
})

describe('assertSameCurrency', () => {
  it('allows matching currencies regardless of case', () => {
    expect(() => assertSameCurrency('usd', 'USD')).not.toThrow()
  })

  it('refuses mixed currencies', () => {
    expect(() => assertSameCurrency('USD', 'EUR')).toThrow(/Cannot combine/)
  })
})
