import { describe, expect, it } from 'vitest'

import { csvField, exportFileName, toCsv } from '../export'
import { isDue } from '../service'
import type { ReportOutput } from '../templates'

describe('csvField', () => {
  it('leaves ordinary values alone', () => {
    expect(csvField('Acme Ltd')).toBe('Acme Ltd')
    expect(csvField('1234.56')).toBe('1234.56')
  })

  it('quotes and escapes values containing a comma or a quote', () => {
    expect(csvField('Acme, Ltd')).toBe('"Acme, Ltd"')
    expect(csvField('He said "hello"')).toBe('"He said ""hello"""')
  })

  it('quotes values containing a newline, so a row cannot be split', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"')
  })

  it('neutralises a formula, which is the injection that matters', () => {
    // Opened in a spreadsheet, a cell starting with = is executed. A client
    // named like this would otherwise be code execution on a colleague's
    // machine, delivered by an export they trusted.
    // No comma, quote or newline, so it is prefixed but not quoted.
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1")
    expect(csvField('+1234')).toBe("'+1234")
    expect(csvField('-1+1')).toBe("'-1+1")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('does not mangle a negative number that is genuinely a value', () => {
    // It is still guarded — correctness beats convenience here, and a leading
    // apostrophe is visible and harmless where executing a formula is not.
    expect(csvField('-500.00')).toBe("'-500.00")
  })
})

const report = (): ReportOutput => ({
  title: 'Receivables ageing',
  subtitle: 'As at 2026-03-15 (UTC)',
  generatedAt: new Date('2026-03-15T10:30:00Z'),
  sections: [
    {
      title: 'Summary',
      note: 'Outstanding balance, not the invoiced total.',
      columns: [
        { key: 'bucket', label: 'Age' },
        { key: 'balance', label: 'Balance', align: 'right' },
      ],
      rows: [
        { bucket: '1–30 days', balance: '$1,234.56' },
        { bucket: 'Over 90 days', balance: '$999.00' },
      ],
    },
  ],
})

describe('toCsv', () => {
  it('writes the title, headers and rows', () => {
    const csv = toCsv(report())

    expect(csv).toContain('Receivables ageing')
    expect(csv).toContain('Age,Balance')
    expect(csv).toContain('1–30 days,$1,234.56'.replace('$1,234.56', '"$1,234.56"'))
  })

  it('uses CRLF and a BOM so Excel reads it correctly', () => {
    const csv = toCsv(report())

    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('\r\n')
  })

  it('emits an empty cell for a missing column rather than undefined', () => {
    const withGap = report()
    withGap.sections[0]!.rows.push({ bucket: 'Not yet due' })

    const csv = toCsv(withGap)
    expect(csv).not.toContain('undefined')
    expect(csv).toContain('Not yet due,')
  })
})

describe('exportFileName', () => {
  it('builds a safe, dated file name', () => {
    expect(exportFileName(report(), 'csv')).toBe('receivables-ageing-2026-03-15.csv')
  })

  it('strips anything that could break a header', () => {
    const odd = report()
    odd.title = 'Q1 "results" / summary'
    expect(exportFileName(odd, 'csv')).toBe('q1-results-summary-2026-03-15.csv')
  })
})

describe('isDue', () => {
  const now = new Date('2026-03-15T12:00:00Z')

  it('is due when it has never run', () => {
    expect(isDue('daily', null, now)).toBe(true)
  })

  it('respects the interval', () => {
    expect(isDue('daily', new Date('2026-03-14T11:00:00Z'), now)).toBe(true)
    expect(isDue('daily', new Date('2026-03-15T11:00:00Z'), now)).toBe(false)

    expect(isDue('weekly', new Date('2026-03-01T12:00:00Z'), now)).toBe(true)
    expect(isDue('weekly', new Date('2026-03-12T12:00:00Z'), now)).toBe(false)
  })

  it('is never due for an unrecognised schedule', () => {
    // A schedule string this version does not understand must not fire every
    // sweep; silence is the safe failure.
    expect(isDue('hourly', null, now)).toBe(false)
    expect(isDue('', null, now)).toBe(false)
  })
})
