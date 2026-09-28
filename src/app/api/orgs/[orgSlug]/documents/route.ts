import { NextResponse } from 'next/server'

import { getRequestContext } from '@/kernel/auth/session'
import { isAppError } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'
import { MAX_UPLOAD_BYTES } from '@/lib/storage'
import { uploadMetaSchema } from '@/modules/documents/schema'
import * as documents from '@/modules/documents/queries'
import { uploadDocument } from '@/modules/documents/binary'

/**
 * Document upload.
 *
 * A route handler rather than a Server Action because the payload is binary:
 * Server Action arguments travel through the React flight payload, which is the
 * wrong transport for a 20 MB file.
 *
 * Authorization is the ordinary path — `requireCtx` resolves the caller's
 * membership from their session cookie, and the org comes from the URL segment
 * only insofar as the caller is proven to belong to it. An `orgSlug` the caller
 * is not a member of resolves to nothing, and the response is 404.
 */
export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params

  try {
    const ctx = await requireCtx(orgSlug)

    // Reject on the declared length before reading the body: there is no point
    // buffering 500 MB to then refuse it.
    const declaredLength = Number(request.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_UPLOAD_BYTES * 1.1) {
      return NextResponse.json({ error: 'That file is too large.' }, { status: 413 })
    }

    const form = await request.formData()
    const file = form.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file was sent.' }, { status: 400 })
    }

    const meta = uploadMetaSchema.safeParse({
      folderId: asString(form.get('folderId')),
      projectId: asString(form.get('projectId')),
      description: asString(form.get('description')),
      visibility: asString(form.get('visibility')) ?? 'ORGANIZATION',
    })

    if (!meta.success) {
      return NextResponse.json({ error: 'Those upload details are not valid.' }, { status: 400 })
    }

    const body = new Uint8Array(await file.arrayBuffer())

    const result = await uploadDocument(
      ctx,
      {
        fileName: file.name,
        declaredType: file.type,
        body,
        folderId: meta.data.folderId,
        projectId: meta.data.projectId,
        description: meta.data.description,
        visibility: meta.data.visibility,
      },
      await getRequestContext(),
    )

    return NextResponse.json({ id: result.id, name: result.name }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

/** Storage usage, for the upload widget's remaining-quota line. */
export async function GET(request: Request, { params }: { params: Promise<{ orgSlug: string }> }) {
  void request
  const { orgSlug } = await params

  try {
    const ctx = await requireCtx(orgSlug)
    const summary = await documents.getStorageSummary(ctx)
    return NextResponse.json(summary)
  } catch (error) {
    return errorResponse(error)
  }
}

function asString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Map an application error to a status.
 *
 * NOT_FOUND and FORBIDDEN both leave as 404 for documents: a 403 confirms the
 * resource exists, and for a file the existence of a name is often the secret.
 */
function errorResponse(error: unknown): NextResponse {
  if (isAppError(error)) {
    switch (error.code) {
      case 'UNAUTHENTICATED':
        return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
      case 'VALIDATION_ERROR':
        return NextResponse.json({ error: error.message }, { status: 400 })
      case 'CONFLICT':
        return NextResponse.json({ error: error.message }, { status: 409 })
      case 'RATE_LIMITED':
        return NextResponse.json({ error: error.message }, { status: 429 })
      default:
        return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }
  }

  console.error('[documents] upload failed', error)
  return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
}
