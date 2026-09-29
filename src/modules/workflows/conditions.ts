import type { Comparator, ConditionExpression } from './graph'

/**
 * The condition interpreter.
 *
 * Two rules, both of which exist because the alternative is a security hole:
 *
 * 1. **No `eval`, no `new Function`, no dynamic property access.** A condition
 *    is a tree of comparisons over a FLAT, pre-built map of allowed fields. A
 *    workflow author cannot reach `constructor`, `__proto__` or anything the
 *    trigger did not publish.
 * 2. **An unknown field is not an error, it is `undefined`.** A published
 *    workflow whose trigger later drops a field should stop matching, not throw
 *    and fail a run. The validator catches unknown fields at publish time,
 *    where a human can see the message.
 */

export type FieldValue = string | number | boolean | Date | null | undefined | string[]

/** The flat, allowlisted view of an entity that conditions may read. */
export type FieldMap = Record<string, FieldValue>

export interface EvaluationContext {
  fields: FieldMap
  /** Fields that changed in the triggering event, for `changed`/`changedTo`. */
  changed?: Record<string, { from: FieldValue; to: FieldValue }>
  now?: Date
}

export function evaluate(expression: ConditionExpression, context: EvaluationContext): boolean {
  switch (expression.kind) {
    case 'always':
      return true

    case 'and':
      return expression.operands.every((operand) => evaluate(operand, context))

    case 'or':
      return expression.operands.some((operand) => evaluate(operand, context))

    case 'not':
      return !evaluate(expression.operand, context)

    case 'compare':
      return compare(expression.field, expression.comparator, expression.value, context)
  }
}

function compare(
  field: string,
  comparator: Comparator,
  expected: unknown,
  context: EvaluationContext,
): boolean {
  // `Object.hasOwn` rather than `in`, so a field named "toString" reads as
  // absent instead of matching something off the prototype.
  const actual = Object.hasOwn(context.fields, field) ? context.fields[field] : undefined

  switch (comparator) {
    case 'isEmpty':
      return isEmpty(actual)

    case 'isNotEmpty':
      return !isEmpty(actual)

    case 'changed':
      return Object.hasOwn(context.changed ?? {}, field)

    case 'changedTo': {
      const change = context.changed?.[field]
      return change !== undefined && looseEquals(change.to, expected)
    }

    case 'eq':
      return looseEquals(actual, expected)

    case 'ne':
      return !looseEquals(actual, expected)

    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.toLowerCase().includes(expected.toLowerCase())
        : Array.isArray(actual) && typeof expected === 'string'
          ? actual.includes(expected)
          : false

    case 'startsWith':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.toLowerCase().startsWith(expected.toLowerCase())
      )

    case 'in':
      return Array.isArray(expected) && expected.some((entry) => looseEquals(actual, entry))

    case 'notIn':
      return Array.isArray(expected) && !expected.some((entry) => looseEquals(actual, entry))

    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false
      const low = numeric(expected[0], context)
      const high = numeric(expected[1], context)
      const value = numeric(actual, context)
      if (low === null || high === null || value === null) return false
      return value >= low && value <= high
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = numeric(actual, context)
      const right = numeric(expected, context)
      if (left === null || right === null) return false

      if (comparator === 'gt') return left > right
      if (comparator === 'gte') return left >= right
      if (comparator === 'lt') return left < right
      return left <= right
    }
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Equality that copes with the shapes a JSON config can hold.
 *
 * A number typed into a form arrives as a string; a date arrives as an ISO
 * string. Comparing those with `===` would silently never match, which is the
 * worst possible failure for a rule engine: no error, just a workflow that
 * quietly never fires.
 */
function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date && typeof expected === 'string') {
    return actual.getTime() === new Date(expected).getTime()
  }
  if (typeof actual === 'number' && typeof expected === 'string') {
    const parsed = Number(expected)
    return Number.isFinite(parsed) && actual === parsed
  }
  if (typeof actual === 'boolean' && typeof expected === 'string') {
    return String(actual) === expected
  }
  if (typeof actual === 'string' && typeof expected === 'number') {
    return actual === String(expected)
  }
  return actual === expected
}

/**
 * Coerce to a number for ordered comparison.
 *
 * Dates become milliseconds so `dueDate < now` works, and the relative literals
 * `now`, `now-7d`, `now+3h` are understood — date arithmetic in a rule is
 * common enough that forcing an author to compute a timestamp would just move
 * the bug into their config.
 */
function numeric(value: unknown, context: EvaluationContext): number | null {
  const now = context.now ?? new Date()

  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0

  if (typeof value === 'string') {
    const relative = parseRelative(value, now)
    if (relative !== null) return relative

    const parsed = Number(value)
    if (Number.isFinite(parsed) && value.trim() !== '') return parsed

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.getTime()
  }

  return null
}

const RELATIVE = /^now(?:\s*([+-])\s*(\d+)([smhdw]))?$/i

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

export function parseRelative(value: string, now: Date): number | null {
  const match = RELATIVE.exec(value.trim())
  if (!match) return null

  const [, sign, amount, unit] = match
  if (!sign || !amount || !unit) return now.getTime()

  const delta = Number(amount) * (UNIT_MS[unit.toLowerCase()] ?? 0)
  return sign === '-' ? now.getTime() - delta : now.getTime() + delta
}

/**
 * Every field a condition reads, for the validator.
 *
 * Collected by walking the tree rather than by regex over the JSON, so a field
 * name that happens to appear inside a string value is not mistaken for one.
 */
export function referencedFields(expression: ConditionExpression): string[] {
  const fields = new Set<string>()

  const walk = (node: ConditionExpression): void => {
    if (node.kind === 'compare') fields.add(node.field)
    else if (node.kind === 'and' || node.kind === 'or') node.operands.forEach(walk)
    else if (node.kind === 'not') walk(node.operand)
  }

  walk(expression)
  return [...fields]
}
