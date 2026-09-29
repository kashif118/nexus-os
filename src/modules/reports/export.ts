import type { ReportOutput } from './templates'

/**
 * Export formats — pure functions from a report to bytes.
 *
 * CSV is implemented properly, including the parts people usually skip:
 * quoting, embedded newlines, and the formula-injection guard.
 *
 * PDF is NOT generated on the server. A print stylesheet is provided instead
 * and the UI says "Print or save as PDF", which uses the browser's own engine.
 * The alternative was a PDF library producing a worse-looking document, or
 * hand-writing PDF syntax — neither of which would be better than what every
 * browser already does well. Recorded in docs/ROADMAP.md §U.
 */

/**
 * Escape one CSV field.
 *
 * The formula guard is the part that matters: a cell beginning `=`, `+`, `-` or
 * `@` is executed as a formula when the file is opened in a spreadsheet, so a
 * client named `=cmd|'/c calc'!A1` becomes code execution on a colleague's
 * machine. Prefixing with an apostrophe is the standard mitigation and costs
 * nothing for ordinary values.
 */
export function csvField(value: string): string {
  const dangerous = /^[=+\-@\t\r]/.test(value)
  const guarded = dangerous ? `'${value}` : value

  if (/["\n\r,]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`
  }

  return guarded
}

export function toCsv(report: ReportOutput): string {
  const lines: string[] = []

  lines.push(csvField(report.title))
  lines.push(csvField(report.subtitle))
  lines.push(csvField(`Generated ${report.generatedAt.toISOString()}`))

  for (const section of report.sections) {
    lines.push('')
    lines.push(csvField(section.title))
    if (section.note) lines.push(csvField(section.note))

    lines.push(section.columns.map((column) => csvField(column.label)).join(','))

    for (const row of section.rows) {
      lines.push(section.columns.map((column) => csvField(row[column.key] ?? '')).join(','))
    }
  }

  // CRLF and a BOM: Excel misreads UTF-8 without them, and a report that opens
  // with mangled accents in the tool people actually use is a broken export.
  return `﻿${lines.join('\r\n')}\r\n`
}

/** A file name that is safe in a Content-Disposition header. */
export function exportFileName(report: ReportOutput, extension: string): string {
  const slug = report.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)

  return `${slug || 'report'}-${report.generatedAt.toISOString().slice(0, 10)}.${extension}`
}
