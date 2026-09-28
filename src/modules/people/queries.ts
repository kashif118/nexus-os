import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/** Read boundary for people Server Components. */

export const listPeople = (ctx: Ctx, search?: string) => service.listPeople(ctx, search)
export const getPerson = (ctx: Ctx, membershipId: string) => service.getPerson(ctx, membershipId)
export const listTeams = (ctx: Ctx) => service.listTeams(ctx)
export const listDepartments = (ctx: Ctx) => service.listDepartments(ctx)
export const listSkills = (ctx: Ctx) => service.listSkills(ctx)
export const getWorkload = (ctx: Ctx) => service.getWorkload(ctx)
export const getPeopleFormOptions = (ctx: Ctx) => service.getPeopleFormOptions(ctx)
