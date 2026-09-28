import { NextResponse } from 'next/server'

import { getRequestContext } from '@/kernel/auth/session'
import { isAppError } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'
import { MAX_UPLOAD_BYTES } from '@/lib/storage'
import { addVersion } from '@/modules/documents/binary'

/** Upload a replacement revision. The previous bytes stay retrievable. */
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgSlug: string; documentId: string }> },
) {
  const { orgSlug, documentId } = await params

  try {
    const ctx = await requireCtx(orgSlug)

    const declaredLength = Number(request.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_UPLOAD_BYTES * 1.1) {
      return NextResponse.json({ error: 'That file is too large.' }, { status: 413 })
    }

    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file was sent.' }, { status: 400 })
    }

    const result = await addVersion(
      ctx,
      {
        documentId,
        fileName: file.name,
        declaredType: file.type,
        body: new Uint8Array(await file.arrayBuffer()),
      },
      await getRequestContext(),
    )

    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === 'UNAUTHENTICATED') {
        return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
      }
      if (error.code === 'VALIDATION_ERROR' || error.code === 'CONFLICT') {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }

    console.error('[documents] version upload failed', error)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
