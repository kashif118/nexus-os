/**
 * Upload content policy — pure functions, so the rules are testable without a
 * request, a database or a filesystem.
 *
 * Three separate checks, because each catches a different attack:
 *
 *  1. **Extension and declared type** — cheap, and rejects the obvious.
 *  2. **Magic bytes** — a browser will happily declare `image/png` for an HTML
 *     file. The first bytes of the actual content are the only claim worth
 *     believing.
 *  3. **Serving rules** — even a file that passes both is served as an
 *     attachment with `nosniff`, never rendered inline. An SVG or an HTML file
 *     rendered from our own origin is a stored XSS with extra steps.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export interface AllowedType {
  mimeType: string
  extensions: string[]
  /** Leading bytes that must match, when the format has a signature. */
  magic?: Array<{ offset: number; bytes: number[] }>
  /** Safe to render in an iframe or <img>. Everything else downloads only. */
  previewable: boolean
}

/**
 * The allowlist. A type that is not listed cannot be uploaded — an allowlist
 * fails closed, a blocklist fails open, and the cost of the stricter choice is
 * a support request rather than an incident.
 *
 * SVG is absent on purpose: it is a script-bearing document, and no amount of
 * sniffing makes one safe to render from our own origin.
 */
export const ALLOWED_TYPES: AllowedType[] = [
  {
    mimeType: 'application/pdf',
    extensions: ['pdf'],
    magic: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
    previewable: true,
  },
  {
    mimeType: 'image/png',
    extensions: ['png'],
    magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
    previewable: true,
  },
  {
    mimeType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    magic: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
    previewable: true,
  },
  {
    mimeType: 'image/gif',
    extensions: ['gif'],
    magic: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }], // GIF8
    previewable: true,
  },
  {
    mimeType: 'image/webp',
    extensions: ['webp'],
    magic: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }], // WEBP at offset 8
    previewable: true,
  },
  {
    mimeType: 'text/plain',
    extensions: ['txt', 'md', 'log'],
    previewable: false,
  },
  {
    mimeType: 'text/csv',
    extensions: ['csv'],
    previewable: false,
  },
  {
    mimeType: 'application/json',
    extensions: ['json'],
    previewable: false,
  },
  {
    mimeType: 'application/zip',
    extensions: ['zip'],
    magic: [{ offset: 0, bytes: [0x50, 0x4b] }], // PK
    previewable: false,
  },
  {
    // Office formats are ZIP containers, so they share the PK signature.
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    magic: [{ offset: 0, bytes: [0x50, 0x4b] }],
    previewable: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    magic: [{ offset: 0, bytes: [0x50, 0x4b] }],
    previewable: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pptx'],
    magic: [{ offset: 0, bytes: [0x50, 0x4b] }],
    previewable: false,
  },
]

export type ContentRejection =
  | { ok: false; reason: 'EMPTY'; message: string }
  | { ok: false; reason: 'TOO_LARGE'; message: string }
  | { ok: false; reason: 'TYPE_NOT_ALLOWED'; message: string }
  | { ok: false; reason: 'EXTENSION_MISMATCH'; message: string }
  | { ok: false; reason: 'CONTENT_MISMATCH'; message: string }

export type ContentDecision =
  { ok: true; mimeType: string; extension: string; previewable: boolean } | ContentRejection

/**
 * Decide whether an upload may be stored, and under what type.
 *
 * The returned `mimeType` is the one the allowlist agrees with, not the one the
 * browser sent — the stored type is what the download handler will later put in
 * a `Content-Type` header, so it must never be attacker-controlled.
 */
export function inspectUpload({
  fileName,
  declaredType,
  body,
  maxBytes = MAX_UPLOAD_BYTES,
}: {
  fileName: string
  declaredType: string
  body: Uint8Array
  maxBytes?: number
}): ContentDecision {
  if (body.byteLength === 0) {
    return { ok: false, reason: 'EMPTY', message: 'That file is empty.' }
  }

  if (body.byteLength > maxBytes) {
    return {
      ok: false,
      reason: 'TOO_LARGE',
      message: `Files must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller.`,
    }
  }

  const extension = extensionOf(fileName)
  const normalisedType = declaredType.split(';')[0]?.trim().toLowerCase() ?? ''

  // Match on the declared type first, then fall back to the extension: some
  // browsers send an empty or generic type for less common formats.
  const byType = ALLOWED_TYPES.find((type) => type.mimeType === normalisedType)
  const byExtension = ALLOWED_TYPES.find((type) => type.extensions.includes(extension))
  const candidate = byType ?? byExtension

  if (!candidate) {
    return {
      ok: false,
      reason: 'TYPE_NOT_ALLOWED',
      message: 'That file type is not accepted.',
    }
  }

  if (!candidate.extensions.includes(extension)) {
    return {
      ok: false,
      reason: 'EXTENSION_MISMATCH',
      message: `A ${candidate.mimeType} file should end in .${candidate.extensions[0]}.`,
    }
  }

  if (candidate.magic && !matchesMagic(body, candidate)) {
    return {
      ok: false,
      reason: 'CONTENT_MISMATCH',
      message: 'The file content does not match its type.',
    }
  }

  return {
    ok: true,
    mimeType: candidate.mimeType,
    extension,
    previewable: candidate.previewable,
  }
}

function matchesMagic(body: Uint8Array, type: AllowedType): boolean {
  return (type.magic ?? []).some((signature) =>
    signature.bytes.every((byte, index) => body[signature.offset + index] === byte),
  )
}

export function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

/** Characters that must never reach a `Content-Disposition` header. */
const FORBIDDEN_IN_HEADER = new Set(['"', '\\', '/', ';', ','])

/**
 * A file name safe to put in a `Content-Disposition` header.
 *
 * Written as an explicit filter rather than a regular expression because the
 * dangerous inputs here are control characters, and a character-class typo in a
 * regex is both easy to make and invisible in review. A newline in this header
 * is a response-splitting vector; a quote breaks out of the quoted string into
 * the header's own grammar; a slash smuggles a path.
 */
export function safeFileName(name: string): string {
  let cleaned = ''
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    if (FORBIDDEN_IN_HEADER.has(character)) continue
    cleaned += character
  }

  cleaned = cleaned.trim()
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'download'
}
