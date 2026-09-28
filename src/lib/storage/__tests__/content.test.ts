import { describe, expect, it } from 'vitest'

import { extensionOf, inspectUpload, safeFileName } from '../content'
import { assertSafeKey, buildStorageKey, normaliseExtension } from '../types'

const bytes = (...values: number[]) => new Uint8Array(values)
const pdf = (extra = 32) => bytes(0x25, 0x50, 0x44, 0x46, ...new Array<number>(extra).fill(0x20))
const png = () => bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)

describe('inspectUpload', () => {
  it('accepts a PDF whose bytes match its claim', () => {
    const result = inspectUpload({
      fileName: 'contract.pdf',
      declaredType: 'application/pdf',
      body: pdf(),
    })

    expect(result).toMatchObject({ ok: true, mimeType: 'application/pdf', extension: 'pdf' })
  })

  it('rejects an HTML file wearing a PNG content type', () => {
    // The classic upload attack: the browser is told to say image/png, but the
    // bytes are markup. Only the magic-byte check catches this.
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')

    const result = inspectUpload({
      fileName: 'avatar.png',
      declaredType: 'image/png',
      body: html,
    })

    expect(result).toMatchObject({ ok: false, reason: 'CONTENT_MISMATCH' })
  })

  it('rejects a mismatched extension even when the bytes are valid', () => {
    const result = inspectUpload({
      fileName: 'report.png',
      declaredType: 'application/pdf',
      body: pdf(),
    })

    expect(result).toMatchObject({ ok: false, reason: 'EXTENSION_MISMATCH' })
  })

  it('rejects an SVG outright — it is a script-bearing document', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

    const result = inspectUpload({
      fileName: 'logo.svg',
      declaredType: 'image/svg+xml',
      body: svg,
    })

    expect(result).toMatchObject({ ok: false, reason: 'TYPE_NOT_ALLOWED' })
  })

  it('rejects an executable', () => {
    const result = inspectUpload({
      fileName: 'setup.exe',
      declaredType: 'application/octet-stream',
      body: bytes(0x4d, 0x5a, 0x90, 0x00),
    })

    expect(result).toMatchObject({ ok: false, reason: 'TYPE_NOT_ALLOWED' })
  })

  it('rejects an empty file', () => {
    const result = inspectUpload({
      fileName: 'empty.pdf',
      declaredType: 'application/pdf',
      body: new Uint8Array(),
    })

    expect(result).toMatchObject({ ok: false, reason: 'EMPTY' })
  })

  it('enforces the size cap', () => {
    const result = inspectUpload({
      fileName: 'big.pdf',
      declaredType: 'application/pdf',
      body: pdf(2_000),
      maxBytes: 1_000,
    })

    expect(result).toMatchObject({ ok: false, reason: 'TOO_LARGE' })
  })

  it('falls back to the extension when the browser sends no type', () => {
    const result = inspectUpload({ fileName: 'notes.txt', declaredType: '', body: bytes(0x41) })
    expect(result).toMatchObject({ ok: true, mimeType: 'text/plain' })
  })

  it('accepts a PNG and marks it previewable', () => {
    const result = inspectUpload({
      fileName: 'chart.png',
      declaredType: 'image/png',
      body: png(),
    })

    expect(result).toMatchObject({ ok: true, previewable: true })
  })

  it('ignores parameters on the declared content type', () => {
    const result = inspectUpload({
      fileName: 'data.csv',
      declaredType: 'text/csv; charset=utf-8',
      body: new TextEncoder().encode('a,b\n1,2'),
    })

    expect(result).toMatchObject({ ok: true, mimeType: 'text/csv' })
  })
})

describe('safeFileName', () => {
  it('strips quotes and slashes that would break the header', () => {
    expect(safeFileName('re"port/2026.pdf')).toBe('report2026.pdf')
  })

  it('strips control characters used for response splitting', () => {
    const attack = `invoice${String.fromCharCode(13)}${String.fromCharCode(10)}Set-Cookie: a=b.pdf`
    expect(safeFileName(attack)).toBe('invoiceSet-Cookie: a=b.pdf')
  })

  it('falls back to a name when everything is stripped', () => {
    expect(safeFileName('///')).toBe('download')
  })

  it('keeps non-ASCII characters, which are legal in the header', () => {
    expect(safeFileName('rapport-financiér.pdf')).toBe('rapport-financiér.pdf')
  })
})

describe('extensionOf', () => {
  it('reads the last extension', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz')
  })

  it('returns empty for a name with no extension', () => {
    expect(extensionOf('README')).toBe('')
  })
})

describe('storage keys', () => {
  it('builds a key under the organization prefix', () => {
    const key = buildStorageKey('org_123', 'pdf')
    expect(key).toMatch(/^org\/org_123\/\d{4}\/[0-9a-f-]+\.pdf$/)
  })

  it('accepts a key it generated', () => {
    expect(() => assertSafeKey(buildStorageKey('org_123', 'png'))).not.toThrow()
  })

  it('refuses a traversal', () => {
    expect(() => assertSafeKey('org/x/2026/../../etc/passwd')).toThrow()
  })

  it('refuses an absolute path', () => {
    expect(() => assertSafeKey('/etc/passwd')).toThrow()
  })

  it('refuses a key that does not match the generated shape', () => {
    expect(() => assertSafeKey('uploads/anything.png')).toThrow()
  })

  it('strips everything but alphanumerics from an extension', () => {
    // The traversal characters do not survive, so the result is inert even
    // though the word itself is kept.
    expect(normaliseExtension('.PDF')).toBe('.pdf')

    // Whatever goes in, what comes out is always a dot plus at most ten
    // lowercase alphanumerics, or nothing at all — that is the property the
    // storage key depends on.
    for (const hostile of ['../../evil', 'pdf; rm -rf /', 'a'.repeat(50), '/', '']) {
      expect(normaliseExtension(hostile)).toMatch(/^(\.[a-z0-9]{1,10})?$/)
    }
  })
})
