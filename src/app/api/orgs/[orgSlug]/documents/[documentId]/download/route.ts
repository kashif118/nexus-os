import { NextResponse } from 'next/server'

import { isAppError } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'
import { safeFileName } from '@/lib/storage'
import { downloadDocument } from '@/modules/documents/binary'

/**
 * Document download — the only path bytes take out of the system.
 *
 * Four properties this handler is responsible for:
 *
 * 1. **Authorization before storage.** The service refuses before it reads, so
 *    an unauthorized request never touches the object store.
 * 2. **404, never 403.** A caller who may not have the file cannot distinguish
 *    "no such document" from "not yours" — with files, the name is frequently
 *    the secret.
 * 3. **Never rendered inline.** `Content-Disposition: attachment` plus
 *    `X-Content-Type-Options: nosniff` means an uploaded HTML or SVG file
 *    downloads rather than executing on our origin as stored XSS.
 * 4. **Never cached shared.** `private, no-store` keeps a document out of any
 *    proxy that might serve it to the next person.
 */
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgSlug: string; documentId: string }> },
) {
  const { orgSlug, documentId } = await params
  const versionId = new URL(request.url).searchParams.get('version') ?? undefined

  try {
    const ctx = await requireCtx(orgSlug)
    const file = await downloadDocument(ctx, documentId, { versionId })

    const name = safeFileName(file.fileName)

    return new NextResponse(file.body as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': file.mimeType,
        'Content-Length': String(file.sizeBytes),
        'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store, max-age=0',
        'Referrer-Policy': 'no-referrer',
      },
    })
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === 'UNAUTHENTICATED') {
        return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
      }
      if (error.code === 'CONFLICT') {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      // NOT_FOUND and FORBIDDEN deliberately collapse into one answer.
      return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }

    console.error('[documents] download failed', error)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
