import { describe, expect, it } from 'vitest'

import { evaluate, parseRelative, referencedFields } from '../conditions'
import type { Comparator, ConditionExpression } from '../graph'

const compare = (field: string, comparator: Comparator, value?: unknown): ConditionExpression => ({
  kind: 'compare',
  field,
  comparator,
  value,
})

const fields = {
  title: 'Overdue invoice',
  totalMinor: 150_000,
  balanceMinor: 150_000,
  status: 'OVERDUE',
  companyName: 'Acme Ltd',
  dueDate: '2026-01-01T00:00:00.000Z',
  tags: ['urgent', 'finance'],
  archived: false,
  note: '',
}

describe('comparisons', () => {
  it('compares numbers, including a string typed into a form', () => {
    expect(evaluate(compare('totalMinor', 'gt', 100_000), { fields })).toBe(true)
    expect(evaluate(compare('totalMinor', 'gt', '100000'), { fields })).toBe(true)
    expect(evaluate(compare('totalMinor', 'lt', 100_000), { fields })).toBe(false)
    expect(evaluate(compare('totalMinor', 'gte', 150_000), { fields })).toBe(true)
    expect(evaluate(compare('totalMinor', 'lte', 150_000), { fields })).toBe(true)
  })

  it('treats a form-entered number as equal to the stored number', () => {
    // The commonest silent failure in a rule engine: a config holds "150000"
    // and the field holds 150000, and `===` quietly never matches.
    expect(evaluate(compare('totalMinor', 'eq', '150000'), { fields })).toBe(true)
  })

  it('compares strings case-insensitively for contains and startsWith', () => {
    expect(evaluate(compare('companyName', 'contains', 'acme'), { fields })).toBe(true)
    expect(evaluate(compare('companyName', 'startsWith', 'ACME'), { fields })).toBe(true)
    expect(evaluate(compare('companyName', 'contains', 'globex'), { fields })).toBe(false)
  })

  it('handles membership tests', () => {
    expect(evaluate(compare('status', 'in', ['SENT', 'OVERDUE']), { fields })).toBe(true)
    expect(evaluate(compare('status', 'notIn', ['SENT', 'OVERDUE']), { fields })).toBe(false)
    expect(evaluate(compare('tags', 'contains', 'urgent'), { fields })).toBe(true)
  })

  it('handles emptiness', () => {
    expect(evaluate(compare('note', 'isEmpty'), { fields })).toBe(true)
    expect(evaluate(compare('title', 'isNotEmpty'), { fields })).toBe(true)
    expect(evaluate(compare('missing', 'isEmpty'), { fields })).toBe(true)
  })

  it('handles ranges', () => {
    expect(evaluate(compare('totalMinor', 'between', [100_000, 200_000]), { fields })).toBe(true)
    expect(evaluate(compare('totalMinor', 'between', [200_000, 300_000]), { fields })).toBe(false)
  })

  it('compares dates against relative expressions', () => {
    const now = new Date('2026-01-10T00:00:00.000Z')

    expect(evaluate(compare('dueDate', 'lt', 'now'), { fields, now })).toBe(true)
    expect(evaluate(compare('dueDate', 'lt', 'now-30d'), { fields, now })).toBe(false)
    expect(evaluate(compare('dueDate', 'gt', 'now-30d'), { fields, now })).toBe(true)
  })

  it('returns false rather than throwing for an unknown field', () => {
    // A published workflow whose trigger later drops a field should stop
    // matching, not crash a run.
    expect(evaluate(compare('nope', 'eq', 'anything'), { fields })).toBe(false)
    expect(evaluate(compare('nope', 'gt', 1), { fields })).toBe(false)
  })

  it('does not read anything off the prototype chain', () => {
    // `'toString' in fields` is true for every object. Using `in` here would
    // let a workflow author read a function and compare against it.
    expect(evaluate(compare('toString', 'isNotEmpty'), { fields })).toBe(false)
    expect(evaluate(compare('constructor', 'isNotEmpty'), { fields })).toBe(false)
    expect(evaluate(compare('__proto__', 'isNotEmpty'), { fields })).toBe(false)
  })

  it('compares booleans written as strings', () => {
    expect(evaluate(compare('archived', 'eq', 'false'), { fields })).toBe(true)
    expect(evaluate(compare('archived', 'eq', 'true'), { fields })).toBe(false)
  })
})

describe('change detection', () => {
  const changed = { status: { from: 'SENT', to: 'OVERDUE' } }

  it('detects that a field changed', () => {
    expect(evaluate(compare('status', 'changed'), { fields, changed })).toBe(true)
    expect(evaluate(compare('title', 'changed'), { fields, changed })).toBe(false)
  })

  it('detects what a field changed to', () => {
    expect(evaluate(compare('status', 'changedTo', 'OVERDUE'), { fields, changed })).toBe(true)
    expect(evaluate(compare('status', 'changedTo', 'PAID'), { fields, changed })).toBe(false)
  })
})

describe('boolean composition', () => {
  it('evaluates and, or and not', () => {
    const expression: ConditionExpression = {
      kind: 'and',
      operands: [
        compare('totalMinor', 'gt', 100_000),
        {
          kind: 'or',
          operands: [compare('status', 'eq', 'OVERDUE'), compare('status', 'eq', 'SENT')],
        },
        { kind: 'not', operand: compare('archived', 'eq', true) },
      ],
    }

    expect(evaluate(expression, { fields })).toBe(true)
  })

  it('fails the whole AND when one operand fails', () => {
    const expression: ConditionExpression = {
      kind: 'and',
      operands: [compare('totalMinor', 'gt', 100_000), compare('status', 'eq', 'PAID')],
    }

    expect(evaluate(expression, { fields })).toBe(false)
  })

  it('always is always true', () => {
    expect(evaluate({ kind: 'always' }, { fields })).toBe(true)
  })
})

describe('parseRelative', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')

  it('understands now and offsets', () => {
    expect(parseRelative('now', now)).toBe(now.getTime())
    expect(parseRelative('now-7d', now)).toBe(now.getTime() - 7 * 86_400_000)
    expect(parseRelative('now + 3h', now)).toBe(now.getTime() + 3 * 3_600_000)
  })

  it('returns null for anything else', () => {
    expect(parseRelative('tomorrow', now)).toBeNull()
    expect(parseRelative('2026-01-01', now)).toBeNull()
  })
})

describe('referencedFields', () => {
  it('collects every field in the tree, and only fields', () => {
    const expression: ConditionExpression = {
      kind: 'and',
      operands: [
        compare('totalMinor', 'gt', 100),
        // The VALUE mentions a field name; it must not be collected.
        compare('status', 'eq', 'companyName'),
        { kind: 'not', operand: compare('dueDate', 'lt', 'now') },
      ],
    }

    expect(referencedFields(expression).sort()).toEqual(['dueDate', 'status', 'totalMinor'])
  })
})
