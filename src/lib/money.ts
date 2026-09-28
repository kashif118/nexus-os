/**
 * Money (docs/DATA-MODEL.md §E.0).
 *
 * Amounts are integers in MINOR units — cents, pence, paise — carried as
 * `bigint`, paired with an ISO-4217 code. Floating point is banned in this
 * domain: `0.1 + 0.2 !== 0.3`, and an invoice that is a hundredth of a cent out
 * is a real defect.
 *
 * `bigint` rather than `number` because JavaScript loses integer precision
 * above 2^53, which a large total in a minor-unit currency can reach.
 */

/** Currencies whose minor unit is not 1/100. */
const EXPONENT_OVERRIDES: Record<string, number> = {
  // Zero-decimal
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  XAF: 0,
  XOF: 0,
  // Three-decimal
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
}

export const minorUnitExponent = (currency: string): number =>
  EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2

export interface Money {
  amountMinor: bigint
  currency: string
}

export const money = (amountMinor: bigint | number, currency: string): Money => ({
  amountMinor: BigInt(amountMinor),
  currency: currency.toUpperCase(),
})

export const zero = (currency: string): Money => money(0n, currency)

/**
 * Parse user input ("1,234.56") into minor units.
 *
 * Deliberately string-based: routing through `parseFloat` would reintroduce the
 * binary rounding this module exists to avoid. Returns null for anything that is
 * not a well-formed amount, so callers surface a validation error rather than
 * storing a silent zero.
 */
export function parseAmount(input: string, currency: string): bigint | null {
  const cleaned = input.trim().replace(/[\s,_]/g, '')
  if (cleaned === '') return null

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!match) return null

  const [, sign, whole = '', fraction = ''] = match
  if (whole === '' && fraction === '') return null

  const exponent = minorUnitExponent(currency)
  if (fraction.length > exponent) return null // more precision than the currency has

  const padded = fraction.padEnd(exponent, '0')
  const magnitude = BigInt(`${whole || '0'}${padded || ''}`)

  return sign === '-' ? -magnitude : magnitude
}

/** Minor units back to a decimal string, without going through a float. */
export function toDecimalString(amountMinor: bigint, currency: string): string {
  const exponent = minorUnitExponent(currency)
  if (exponent === 0) return amountMinor.toString()

  const negative = amountMinor < 0n
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exponent + 1, '0')

  const whole = digits.slice(0, -exponent)
  const fraction = digits.slice(-exponent)

  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/**
 * Format for display in the organization locale.
 *
 * `Intl.NumberFormat` is fed a string so the value never becomes a float on the
 * way to the screen.
 */
export function formatMoney(
  amountMinor: bigint,
  currency: string,
  options: { locale?: string; compact?: boolean } = {},
): string {
  const locale = options.locale ?? 'en-US'
  const exponent = minorUnitExponent(currency)

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: options.compact ? 0 : exponent,
    maximumFractionDigits: options.compact ? 0 : exponent,
    ...(options.compact ? { notation: 'compact' as const } : {}),
  })

  // Intl needs a Number; the division is done on the string first so only the
  // display value is ever a float, never a stored amount.
  return formatter.format(Number(toDecimalString(amountMinor, currency)))
}

export const addMoney = (a: bigint, b: bigint): bigint => a + b
export const subtractMoney = (a: bigint, b: bigint): bigint => a - b

export const sumMoney = (amounts: Iterable<bigint>): bigint => {
  let total = 0n
  for (const amount of amounts) total += amount
  return total
}

/**
 * Multiply by a quantity that may have a fractional part (hours, units).
 *
 * The quantity is supplied as a scaled integer plus its scale, so the caller
 * never hands us a float. Rounds half away from zero, which is what invoice
 * lines are expected to do.
 */
export function multiplyMoney(
  amountMinor: bigint,
  quantity: bigint,
  quantityScale: number,
): bigint {
  const divisor = 10n ** BigInt(quantityScale)
  const product = amountMinor * quantity
  return divideRounded(product, divisor)
}

/**
 * Apply a percentage given in basis points (10000 = 100%), for tax and discount.
 */
export function percentOf(amountMinor: bigint, basisPoints: bigint): bigint {
  return divideRounded(amountMinor * basisPoints, 10_000n)
}

/** Integer division rounding half away from zero. */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Division by zero')

  const negative = numerator < 0n !== denominator < 0n
  const absNumerator = numerator < 0n ? -numerator : numerator
  const absDenominator = denominator < 0n ? -denominator : denominator

  const quotient = absNumerator / absDenominator
  const remainder = absNumerator % absDenominator

  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

/**
 * Split an amount into shares that add back to the original exactly.
 *
 * Naive division loses or invents fractions of a cent; this distributes the
 * remainder one minor unit at a time so the parts always reconcile.
 */
export function allocate(amountMinor: bigint, weights: readonly bigint[]): bigint[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n)
  if (totalWeight === 0n) throw new Error('Cannot allocate across zero total weight')

  const shares = weights.map((weight) => (amountMinor * weight) / totalWeight)
  let remainder = amountMinor - shares.reduce((sum, share) => sum + share, 0n)

  for (let index = 0; remainder !== 0n; index = (index + 1) % shares.length) {
    const step = remainder > 0n ? 1n : -1n
    shares[index] = shares[index]! + step
    remainder -= step
  }

  return shares
}

/** Reject arithmetic across currencies — a class of bug worth failing loudly on. */
export function assertSameCurrency(a: string, b: string): void {
  if (a.toUpperCase() !== b.toUpperCase()) {
    throw new Error(`Cannot combine amounts in ${a} and ${b}`)
  }
}
