import { z } from 'zod'

import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'
import * as crm from '@/modules/crm/queries'
import * as documents from '@/modules/documents/queries'
import * as finance from '@/modules/finance/queries'
import * as people from '@/modules/people/queries'
import * as projects from '@/modules/projects/queries'
import * as tasks from '@/modules/tasks/queries'

import { defineTool } from './registry'

/**
 * The read tools.
 *
 * Every one of them goes through a module's QUERY boundary — the same function
 * the corresponding page calls. That is the whole design: the assistant sees
 * exactly what the user would see by navigating there themselves, including
 * every scope rule (own versus any), every soft-delete filter and every
 * redaction, because it is the same code path.
 *
 * No tool here builds a Prisma query, and none takes an organization id: the
 * organization comes from the context, which came from the session.
 */

const listParams = <T extends string>(field: T, take = 20): ListParams<T> => ({
  page: 1,
  pageSize: take,
  skip: 0,
  take,
  sort: { field, direction: 'desc' },
  q: undefined,
})

const withQuery = <T extends string>(params: ListParams<T>, q?: string): ListParams<T> =>
  q && q.trim().length > 0 ? { ...params, q: q.trim() } : params

const searchArgs = z.object({
  query: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(50).default(20),
})

const searchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Free-text search. Omit to list the most recent.' },
    limit: { type: 'number', description: 'How many to return, at most 50.' },
  },
} as const

/* --------------------------------- projects -------------------------------- */

defineTool({
  name: 'searchProjects',
  description:
    'Find projects by name or key. Returns status, health, progress and dates. Use this before answering anything about project state.',
  parameters: searchArgs,
  jsonSchema: searchSchema,
  requiredPermissions: [],
  sideEffect: 'read',
  async handler(ctx: Ctx, args) {
    const page = await projects.listProjects(
      ctx,
      withQuery(listParams('createdAt', args.limit), args.query),
    )

    return page.items.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      status: project.status,
      priority: project.priority,
      health: project.healthStatus,
      healthScore: project.healthScore,
      progressPercent: project.progressPercent,
      dueDate: project.dueDate,
      client: project.company?.name ?? null,
    }))
  },
})

defineTool({
  name: 'getProjectDetails',
  description: 'Full detail for one project: milestones, members, health signals and progress.',
  parameters: z.object({ projectId: z.string().min(1).max(64) }),
  jsonSchema: {
    type: 'object',
    properties: { projectId: { type: 'string' } },
    required: ['projectId'],
  },
  requiredPermissions: [],
  sideEffect: 'read',
  handler: (ctx: Ctx, args) => projects.getProject(ctx, args.projectId),
})

/* ---------------------------------- tasks ---------------------------------- */

defineTool({
  name: 'searchTasks',
  description:
    'Find tasks by title. Returns status, priority, assignee and due date. Respects what the caller may see.',
  parameters: searchArgs.extend({
    status: z.enum(['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED']).optional(),
    mine: z.boolean().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      status: {
        type: 'string',
        enum: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED'],
      },
      mine: { type: 'boolean', description: 'Only tasks assigned to the caller.' },
      limit: { type: 'number' },
    },
  },
  requiredPermissions: ['task.read'],
  sideEffect: 'read',
  async handler(ctx: Ctx, args) {
    const page = await tasks.listTasks(
      ctx,
      withQuery(listParams('createdAt', args.limit), args.query),
      {
        ...(args.status ? { status: args.status } : {}),
        ...(args.mine ? { assigneeMembershipId: ctx.membershipId } : {}),
      },
    )

    return page.items.map((task) => ({
      id: task.id,
      number: task.number,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      assignee: task.assignee?.user.name ?? null,
      project: task.project?.key ?? null,
    }))
  },
})

/* ----------------------------------- CRM ----------------------------------- */

defineTool({
  name: 'searchCompanies',
  description: 'Find client companies by name, with their contact and deal counts.',
  parameters: searchArgs,
  jsonSchema: searchSchema,
  requiredPermissions: ['crm.company.read'],
  sideEffect: 'read',
  async handler(ctx: Ctx, args) {
    const page = await crm.listCompanies(
      ctx,
      withQuery(listParams('createdAt', args.limit), args.query),
    )

    return page.items.map((company) => ({
      id: company.id,
      name: company.name,
      industry: company.industry,
      contacts: company._count.contacts,
      deals: company._count.deals,
    }))
  },
})

defineTool({
  name: 'searchDeals',
  description:
    'Find deals in the pipeline. Deal values are included only if the caller may see them.',
  parameters: searchArgs.extend({ status: z.enum(['OPEN', 'WON', 'LOST']).optional() }),
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      status: { type: 'string', enum: ['OPEN', 'WON', 'LOST'] },
      limit: { type: 'number' },
    },
  },
  requiredPermissions: ['crm.deal.read'],
  sideEffect: 'read',
  async handler(ctx: Ctx, args) {
    const page = await crm.listDeals(
      ctx,
      withQuery(listParams('createdAt', args.limit), args.query),
      args.status ? { status: args.status } : {},
    )

    const canSeeValue = ctx.can('crm.deal.value.view')

    return page.items.map((deal) => ({
      id: deal.id,
      title: deal.title,
      status: deal.status,
      stage: deal.stage?.name ?? null,
      company: deal.company?.name ?? null,
      // A value the caller may not see is omitted rather than zeroed: a zero
      // would be a wrong fact, and the model would repeat it as one.
      ...(canSeeValue ? { valueMinor: deal.valueMinor, currency: deal.currency } : {}),
      expectedCloseDate: deal.expectedCloseDate,
    }))
  },
})

/* --------------------------------- finance --------------------------------- */

defineTool({
  name: 'searchInvoices',
  description: 'Find invoices with their status, totals and outstanding balance.',
  parameters: searchArgs.extend({
    status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      status: { type: 'string', enum: ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] },
      limit: { type: 'number' },
    },
  },
  requiredPermissions: ['finance.invoice.read'],
  sideEffect: 'read',
  async handler(ctx: Ctx, args) {
    const page = await finance.listInvoices(
      ctx,
      withQuery(listParams('issueDate', args.limit), args.query),
      args.status ? { status: args.status } : {},
    )

    return page.items.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      client: invoice.company.name,
      currency: invoice.currency,
      totalMinor: invoice.totalMinor,
      balanceMinor: invoice.balanceMinor,
      dueDate: invoice.dueDate,
    }))
  },
})

defineTool({
  name: 'getFinancialSummary',
  description:
    'Revenue received, approved expenses and net cash for the year to date, plus invoices by status. Revenue means payments banked, not invoices raised.',
  parameters: z.object({}),
  jsonSchema: { type: 'object', properties: {} },
  requiredPermissions: ['finance.report.view'],
  sideEffect: 'read',
  handler: (ctx: Ctx) => finance.getFinancialSummary(ctx),
})

/* ---------------------------------- people --------------------------------- */

defineTool({
  name: 'searchPeople',
  description:
    'Find members of the organization with their role and position. Pay rates are never included.',
  parameters: z.object({ query: z.string().max(120).optional() }),
  jsonSchema: { type: 'object', properties: { query: { type: 'string' } } },
  requiredPermissions: ['people.read'],
  sideEffect: 'read',
  async handler(ctx: Ctx, args) {
    const rows = await people.listPeople(ctx, args.query)

    // The service already redacts rates for a caller without the permission;
    // they are dropped here regardless, because a prompt is a place data goes
    // to be copied and a model has no use for a salary.
    return rows.map((person) => ({
      membershipId: person.membershipId,
      name: person.name,
      position: person.position,
      department: person.departmentName,
      employmentType: person.employmentType,
    }))
  },
})

defineTool({
  name: 'getTeamWorkload',
  description: 'Assigned work per person against their weekly capacity.',
  parameters: z.object({}),
  jsonSchema: { type: 'object', properties: {} },
  requiredPermissions: ['people.workload.view'],
  sideEffect: 'read',
  handler: (ctx: Ctx) => people.getWorkload(ctx),
})

/* -------------------------------- documents -------------------------------- */

defineTool({
  name: 'searchDocuments',
  description:
    'Find documents by name or description. Returns metadata only — never the file contents, and never anything the caller may not open.',
  parameters: searchArgs,
  jsonSchema: searchSchema,
  requiredPermissions: [],
  sideEffect: 'read',
  async handler(ctx: Ctx, args) {
    const page = await documents.listDocuments(
      ctx,
      withQuery(listParams('createdAt', args.limit), args.query),
    )

    return page.items.map((document) => ({
      id: document.id,
      name: document.name,
      description: document.description,
      mimeType: document.mimeType,
      visibility: document.visibility,
      createdAt: document.createdAt,
    }))
  },
})
