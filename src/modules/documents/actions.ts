'use server'

import { revalidatePath } from 'next/cache'

import { getRequestContext } from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { requireCtx } from '@/kernel/tenancy/ctx'

import {
  attachSchema,
  documentUpdateSchema,
  folderSchema,
  idSchema,
  revokeSchema,
  shareSchema,
} from './schema'
import * as service from './service'

export type FormState = ActionResult<{ message?: string; id?: string }> | null

function parse<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  formData: FormData,
): { ok: true; data: T } | { ok: false; result: ActionResult<never> } {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))

  if (!parsed.success || parsed.data === undefined) {
    const fields: Record<string, string[]> = {}
    const issues = (parsed.error as { issues?: Array<{ path: PropertyKey[]; message: string }> })
      ?.issues
    for (const issue of issues ?? []) {
      const key = String(issue.path[0] ?? 'form')
      ;(fields[key] ??= []).push(issue.message)
    }
    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Check the highlighted fields.', fields },
      },
    }
  }

  return { ok: true, data: parsed.data }
}

const ok = (message: string, id?: string): FormState => ({
  ok: true,
  data: id === undefined ? { message } : { message, id },
})

/**
 * Uploads do NOT go through a Server Action.
 *
 * A Server Action serialises its arguments through the React payload, which is
 * the wrong transport for tens of megabytes of binary. Files are posted to the
 * route handler at `/api/orgs/[orgSlug]/documents`, which streams the multipart
 * body. Everything else about a document is a normal action.
 */

export async function createFolderAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(folderSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    const folder = await service.createFolder(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/documents`)
    return ok('Folder created.', folder.id)
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteFolderAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteFolder(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/documents`)
    return ok('Folder deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function updateDocumentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(documentUpdateSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.updateDocument(
      ctx,
      parsed.data.id,
      {
        name: parsed.data.name,
        description: parsed.data.description,
        folderId: parsed.data.folderId,
        visibility: parsed.data.visibility,
      },
      await getRequestContext(),
    )

    revalidatePath(`/${orgSlug}/documents/${parsed.data.id}`)
    revalidatePath(`/${orgSlug}/documents`)
    return ok('Document saved.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteDocumentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.deleteDocument(ctx, parsed.data.id, await getRequestContext())
    revalidatePath(`/${orgSlug}/documents`)
    return ok('Document deleted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function shareDocumentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(shareSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.shareDocument(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/documents/${parsed.data.documentId}`)
    return ok('Access granted.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function revokeGrantAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(revokeSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.revokeGrant(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}/documents/${parsed.data.documentId}`)
    return ok('Access removed.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function attachDocumentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(attachSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.attachDocument(ctx, parsed.data, await getRequestContext())
    revalidatePath(`/${orgSlug}`)
    return ok('Attached.')
  } catch (error) {
    return toActionResult(error)
  }
}

export async function detachDocumentAction(
  orgSlug: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parse(idSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const ctx = await requireCtx(orgSlug)
    await service.detachDocument(ctx, parsed.data.id)
    revalidatePath(`/${orgSlug}`)
    return ok('Removed.')
  } catch (error) {
    return toActionResult(error)
  }
}
