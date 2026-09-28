import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'

import type {
  COMPANY_SORT_FIELDS,
  CONTACT_SORT_FIELDS,
  DEAL_SORT_FIELDS,
  LEAD_SORT_FIELDS,
} from './schema'
import * as service from './service'

/** Read boundary for CRM Server Components. */

export const listCompanies = (ctx: Ctx, params: ListParams<(typeof COMPANY_SORT_FIELDS)[number]>) =>
  service.listCompanies(ctx, params)

export const getCompany = (ctx: Ctx, id: string) => service.getCompany(ctx, id)

export const listContacts = (
  ctx: Ctx,
  params: ListParams<(typeof CONTACT_SORT_FIELDS)[number]>,
  companyId?: string,
) => service.listContacts(ctx, params, companyId)

export const getContact = (ctx: Ctx, id: string) => service.getContact(ctx, id)

export const listLeads = (
  ctx: Ctx,
  params: ListParams<(typeof LEAD_SORT_FIELDS)[number]>,
  filters?: { status?: string | undefined },
) => service.listLeads(ctx, params, filters)

export const getLead = (ctx: Ctx, id: string) => service.getLead(ctx, id)

export const listDeals = (
  ctx: Ctx,
  params: ListParams<(typeof DEAL_SORT_FIELDS)[number]>,
  filters?: { status?: string | undefined; pipelineId?: string | undefined },
) => service.listDeals(ctx, params, filters)

export const getDeal = (ctx: Ctx, id: string) => service.getDeal(ctx, id)

export const getPipelineBoard = (ctx: Ctx, pipelineId?: string) =>
  service.getPipelineBoard(ctx, pipelineId)

export const ensureDefaultPipeline = (ctx: Ctx) => service.ensureDefaultPipeline(ctx)

export const getPickerOptions = (ctx: Ctx) => service.getPickerOptions(ctx)

export const listTags = (ctx: Ctx) => service.listTags(ctx)

export const listPipelines = (ctx: Ctx) => service.listPipelines(ctx)
