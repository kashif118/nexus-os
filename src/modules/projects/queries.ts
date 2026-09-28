import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'

import type { ProjectSort } from './repository'
import * as service from './service'

/** Read boundary for project Server Components. */

export const listProjects = (
  ctx: Ctx,
  params: ListParams<ProjectSort>,
  filters?: {
    status?: string | undefined
    companyId?: string | undefined
    health?: string | undefined
  },
) => service.listProjects(ctx, params, filters)

export const getProject = (ctx: Ctx, id: string) => service.getProject(ctx, id)

export const getProjectFormOptions = (ctx: Ctx) => service.getProjectFormOptions(ctx)

export const getPortfolioSummary = (ctx: Ctx) => service.getPortfolioSummary(ctx)

export const listProjectOptions = (ctx: Ctx) => service.listProjectOptions(ctx)
