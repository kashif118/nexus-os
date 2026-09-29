import type { Ctx } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'

import * as repository from './repository'

/**
 * The insight engine.
 *
 * Every insight here is COMPUTED from rows, not generated. That is a deliberate
 * architectural choice, not a limitation of this deployment: a model asked to
 * find problems in a dataset will find some that are not there, and an
 * executive dashboard is the worst possible place for a confident invention.
 *
 * So the division of labour is: SQL finds the facts and decides severity; the
 * model — when one is configured — may later phrase them. The numbers are never
 * the model's.
 *
 * Every insight carries `evidence`: the records it came from, with ids. An
 * insight that cannot cite its source is not written.
 *
 * Each analysis also declares the permission a viewer needs. An insight about
 * overdue invoices is not shown to somebody who cannot see invoices — the
 * insight itself would leak the fact that a large one is unpaid.
 */

export interface Evidence {
  entityType: string
  entityId: string
  label: string
}

export interface ComputedInsight {
  dedupeKey: string
  kind: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  title: string
  detail: string
  evidence: Evidence[]
  requiredPermission: string | null
}

/**
 * Recompute every analysis for one organization.
 *
 * Runs with a real `Ctx`, so each analysis sees exactly what that caller may
 * see. In practice the sweep runs as an administrator; running it as a
 * restricted user would produce a smaller, still-correct set.
 */
export async function computeInsights(ctx: Ctx): Promise<ComputedInsight[]> {
  const analyses = await Promise.all([
    overdueInvoices(ctx),
    stalledDeals(ctx),
    atRiskProjects(ctx),
    expenseBacklog(ctx),
    workloadImbalance(ctx),
  ])

  return analyses.flat()
}

/** Recompute and store. Insights that no longer hold are removed. */
export async function refreshInsights(ctx: Ctx): Promise<{ written: number }> {
  const computed = await computeInsights(ctx)

  const byKind = new Map<string, string[]>()
  for (const insight of computed) {
    byKind.set(insight.kind, [...(byKind.get(insight.kind) ?? []), insight.dedupeKey])
  }

  for (const kind of [
    'OVERDUE_INVOICES',
    'STALLED_DEALS',
    'AT_RISK_PROJECTS',
    'EXPENSE_BACKLOG',
    'WORKLOAD_IMBALANCE',
  ]) {
    await repository.clearInsights(ctx.orgId, kind, byKind.get(kind) ?? [])
  }

  for (const insight of computed) {
    await repository.upsertInsight(ctx.orgId, insight)
  }

  return { written: computed.length }
}

/* -------------------------------------------------------------------------- */
/* Analyses                                                                    */
/* -------------------------------------------------------------------------- */

async function overdueInvoices(ctx: Ctx): Promise<ComputedInsight[]> {
  if (!ctx.can('finance.invoice.read')) return []

  const invoices = await ctx.db.invoice.findMany({
    where: { deletedAt: null, status: { in: ['SENT', 'OVERDUE'] }, dueDate: { lt: new Date() } },
    orderBy: { balanceMinor: 'desc' },
    take: 20,
    select: {
      id: true,
      number: true,
      balanceMinor: true,
      currency: true,
      dueDate: true,
      company: { select: { name: true } },
    },
  })

  if (invoices.length === 0) return []

  const totalMinor = invoices.reduce((sum, invoice) => sum + invoice.balanceMinor, 0n)
  const oldest = invoices.reduce(
    (worst, invoice) => (invoice.dueDate < worst ? invoice.dueDate : worst),
    invoices[0]!.dueDate,
  )
  const daysLate = Math.floor((Date.now() - oldest.getTime()) / 86_400_000)

  return [
    {
      dedupeKey: 'overdue-invoices',
      kind: 'OVERDUE_INVOICES',
      severity: daysLate > 60 ? 'CRITICAL' : daysLate > 30 ? 'WARNING' : 'INFO',
      title: `${formatMoney(totalMinor, invoices[0]!.currency)} is overdue across ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`,
      detail: `The oldest is ${daysLate} day${daysLate === 1 ? '' : 's'} past its due date. This is the outstanding balance, not the invoiced total.`,
      evidence: invoices.map((invoice) => ({
        entityType: 'Invoice',
        entityId: invoice.id,
        label: `${invoice.number} · ${invoice.company.name} · ${formatMoney(invoice.balanceMinor, invoice.currency)}`,
      })),
      requiredPermission: 'finance.invoice.read',
    },
  ]
}

async function stalledDeals(ctx: Ctx): Promise<ComputedInsight[]> {
  if (!ctx.can('crm.deal.read')) return []

  const threshold = new Date(Date.now() - 30 * 86_400_000)

  const deals = await ctx.db.deal.findMany({
    where: { deletedAt: null, status: 'OPEN', updatedAt: { lt: threshold } },
    orderBy: { updatedAt: 'asc' },
    take: 15,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      valueMinor: true,
      currency: true,
      stage: { select: { name: true } },
      company: { select: { name: true } },
    },
  })

  if (deals.length === 0) return []

  const canSeeValue = ctx.can('crm.deal.value.view')
  const oldestDays = Math.floor((Date.now() - deals[0]!.updatedAt.getTime()) / 86_400_000)

  return [
    {
      dedupeKey: 'stalled-deals',
      kind: 'STALLED_DEALS',
      severity: deals.length >= 5 ? 'WARNING' : 'INFO',
      title: `${deals.length} open deal${deals.length === 1 ? ' has' : 's have'} not moved in over 30 days`,
      detail: `The most stagnant has been untouched for ${oldestDays} days. Stage age is measured from the last change to the deal, not from when it was created.`,
      evidence: deals.map((deal) => ({
        entityType: 'Deal',
        entityId: deal.id,
        label: [
          deal.title,
          deal.company?.name,
          deal.stage?.name,
          canSeeValue ? formatMoney(deal.valueMinor, deal.currency) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      requiredPermission: 'crm.deal.read',
    },
  ]
}

async function atRiskProjects(ctx: Ctx): Promise<ComputedInsight[]> {
  const projects = await ctx.db.project.findMany({
    where: { deletedAt: null, status: 'ACTIVE', healthStatus: { in: ['AT_RISK', 'CRITICAL'] } },
    orderBy: { healthScore: 'asc' },
    take: 15,
    select: {
      id: true,
      key: true,
      name: true,
      healthStatus: true,
      healthScore: true,
      progressPercent: true,
      dueDate: true,
    },
  })

  if (projects.length === 0) return []

  const critical = projects.filter((project) => project.healthStatus === 'CRITICAL').length

  return [
    {
      dedupeKey: 'at-risk-projects',
      kind: 'AT_RISK_PROJECTS',
      severity: critical > 0 ? 'CRITICAL' : 'WARNING',
      title: `${projects.length} active project${projects.length === 1 ? ' is' : 's are'} off track`,
      detail:
        critical > 0
          ? `${critical} of them is scored critical. Health is derived from overdue tasks, missed milestones, remaining time and budget — it is not a manual flag.`
          : 'Health is derived from overdue tasks, missed milestones, remaining time and budget — it is not a manual flag.',
      evidence: projects.map((project) => ({
        entityType: 'Project',
        entityId: project.id,
        label: `${project.key} · ${project.name} · ${project.progressPercent}% complete · health ${project.healthScore}`,
      })),
      requiredPermission: null,
    },
  ]
}

async function expenseBacklog(ctx: Ctx): Promise<ComputedInsight[]> {
  if (!ctx.can('finance.expense.approve')) return []

  const threshold = new Date(Date.now() - 7 * 86_400_000)

  const expenses = await ctx.db.expense.findMany({
    where: { deletedAt: null, status: 'SUBMITTED', createdAt: { lt: threshold } },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: {
      id: true,
      vendor: true,
      amountMinor: true,
      taxMinor: true,
      currency: true,
      createdAt: true,
      submittedBy: { select: { user: { select: { name: true } } } },
    },
  })

  if (expenses.length === 0) return []

  const totalMinor = expenses.reduce(
    (sum, expense) => sum + expense.amountMinor + expense.taxMinor,
    0n,
  )
  const waitingDays = Math.floor((Date.now() - expenses[0]!.createdAt.getTime()) / 86_400_000)

  return [
    {
      dedupeKey: 'expense-backlog',
      kind: 'EXPENSE_BACKLOG',
      severity: waitingDays > 21 ? 'WARNING' : 'INFO',
      title: `${expenses.length} expense claim${expenses.length === 1 ? '' : 's'} waiting more than a week`,
      detail: `${formatMoney(totalMinor, expenses[0]!.currency)} is unapproved, and the oldest has waited ${waitingDays} days. People are out of pocket until these are decided.`,
      evidence: expenses.map((expense) => ({
        entityType: 'Expense',
        entityId: expense.id,
        label: `${expense.vendor ?? 'Claim'} · ${expense.submittedBy?.user.name ?? 'former member'} · ${formatMoney(expense.amountMinor + expense.taxMinor, expense.currency)}`,
      })),
      requiredPermission: 'finance.expense.approve',
    },
  ]
}

async function workloadImbalance(ctx: Ctx): Promise<ComputedInsight[]> {
  if (!ctx.can('people.workload.view')) return []

  const open = await ctx.db.task.groupBy({
    by: ['assigneeMembershipId'],
    where: {
      deletedAt: null,
      status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] },
      assigneeMembershipId: { not: null },
    },
    _count: { _all: true },
  })

  if (open.length < 3) return []

  const counts = open.map((row) => row._count._all)
  const total = counts.reduce((sum, count) => sum + count, 0)
  const mean = total / counts.length
  const busiest = open.reduce((worst, row) => (row._count._all > worst._count._all ? row : worst))

  // A meaningful imbalance, not a rounding artefact: at least double the mean
  // and at least five tasks clear of it.
  if (busiest._count._all < mean * 2 || busiest._count._all - mean < 5) return []

  const membership = await ctx.db.membership.findFirst({
    where: { id: busiest.assigneeMembershipId ?? '' },
    select: { id: true, user: { select: { name: true } } },
  })

  if (!membership) return []

  return [
    {
      dedupeKey: `workload-${membership.id}`,
      kind: 'WORKLOAD_IMBALANCE',
      severity: 'WARNING',
      title: `${membership.user.name} is holding ${busiest._count._all} open tasks`,
      detail: `The average across ${open.length} people with assigned work is ${mean.toFixed(1)}. This counts open tasks, not effort, so check the estimates before rebalancing.`,
      evidence: [
        {
          entityType: 'Membership',
          entityId: membership.id,
          label: `${membership.user.name} · ${busiest._count._all} open tasks`,
        },
      ],
      requiredPermission: 'people.workload.view',
    },
  ]
}
