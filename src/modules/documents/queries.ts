import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'

import type { DocumentSort } from './schema'
import * as service from './service'

/** Read boundary for document Server Components. */

export const listDocuments = (
  ctx: Ctx,
  params: ListParams<DocumentSort>,
  filters?: { folderId?: string | undefined; projectId?: string | undefined },
) => service.listDocuments(ctx, params, filters)

export const getDocument = (ctx: Ctx, id: string) => service.getDocument(ctx, id)
export const listFolders = (ctx: Ctx) => service.listFolders(ctx)
export const listGrants = (ctx: Ctx, documentId: string) => service.listGrants(ctx, documentId)
export const listAttachments = (ctx: Ctx, entityType: string, entityId: string) =>
  service.listAttachments(ctx, entityType, entityId)
export const getStorageSummary = (ctx: Ctx) => service.getStorageSummary(ctx)
export const listShareTargets = (ctx: Ctx) => service.listShareTargets(ctx)
