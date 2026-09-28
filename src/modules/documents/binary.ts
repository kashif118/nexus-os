import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'
import type { Visibility } from './access'

/**
 * The transport boundary for binary traffic.
 *
 * `actions.ts` and `queries.ts` are the boundary for everything a Server
 * Component or form touches; this file is the equivalent for the two route
 * handlers that move bytes, which cannot be Server Actions because a multi-
 * megabyte file has no business travelling through the React payload.
 *
 * It exists so the route handlers never import the service directly — the same
 * layering rule the rest of the application follows, enforced by
 * `eslint-plugin-boundaries`.
 */

export function uploadDocument(
  ctx: Ctx,
  input: {
    fileName: string
    declaredType: string
    body: Uint8Array
    folderId?: string | undefined
    projectId?: string | undefined
    description?: string | undefined
    visibility?: Visibility | undefined
  },
  meta: { ip: string | null; userAgent: string | null },
) {
  return service.uploadDocument(ctx, input, meta)
}

export function addVersion(
  ctx: Ctx,
  input: { documentId: string; fileName: string; declaredType: string; body: Uint8Array },
  meta: { ip: string | null; userAgent: string | null },
) {
  return service.addVersion(ctx, input, meta)
}

export function downloadDocument(
  ctx: Ctx,
  id: string,
  options?: { versionId?: string | undefined },
) {
  return service.downloadDocument(ctx, id, options)
}
