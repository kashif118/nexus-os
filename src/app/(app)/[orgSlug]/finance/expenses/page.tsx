import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { parseListParams } from '@/kernel/validation/list-params'
import { SearchInput } from '@/modules/crm/components/search-input'
import {
  ExpenseDecisionControls,
  ExpenseForm,
  SubmitExpenseButton,
} from '@/modules/finance/components/expense-forms'
import { ExpenseTable } from '@/modules/finance/components/finance-tables'
import { getExpense, getFinanceFormOptions, listExpenses } from '@/modules/finance/queries'
import { EXPENSE_SORT_FIELDS, EXPENSE_STATUSES } from '@/modules/finance/schema'

export const metadata: Metadata = { title: 'Expenses' }

export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.canAny(['finance.expense.read.any', 'finance.expense.read.own'])) notFound()

  const resolved = await searchParams
  const listParams = parseListParams(resolved, {
    sortableFields: EXPENSE_SORT_FIELDS,
    defaultSort: 'incurredOn',
    defaultDirection: 'desc',
  })

  const requested = Array.isArray(resolved.status) ? resolved.status[0] : resolved.status
  const status = EXPENSE_STATUSES.includes(requested as never) ? requested : undefined
  const selectedId = Array.isArray(resolved.expense) ? resolved.expense[0] : resolved.expense

  const [page, options] = await Promise.all([
    listExpenses(ctx, listParams, { status }),
    ctx.can('finance.expense.create') ? getFinanceFormOptions(ctx) : null,
  ])

  // A selected expense is re-fetched through the service so the scope rule
  // applies: `read.own` cannot open a colleague's claim by guessing the id.
  let selected: Awaited<ReturnType<typeof getExpense>> | null = null
  if (selectedId) {
    try {
      selected = await getExpense(ctx, selectedId)
    } catch (error) {
      if (!isAppError(error)) throw error
      selected = null
    }
  }

  const base = `/${orgSlug}/finance/expenses?${status ? `status=${status}&` : ''}`

  return (
    <div className="space-y-4">
      <PageHeader
        title="Expenses"
        description={
          ctx.can('finance.expense.read.any')
            ? 'Every claim in the organization.'
            : 'Your own claims.'
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search vendor or description…" />
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter by status">
          <Link
            href={`/${orgSlug}/finance/expenses`}
            className={`rounded-md px-2 py-1 ${!status ? 'bg-accent' : 'hover:bg-accent/60'}`}
          >
            All
          </Link>
          {EXPENSE_STATUSES.map((value) => (
            <Link
              key={value}
              href={`/${orgSlug}/finance/expenses?status=${value}`}
              className={`rounded-md px-2 py-1 ${status === value ? 'bg-accent' : 'hover:bg-accent/60'}`}
            >
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ExpenseTable
            rows={page.items}
            pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
            sort={listParams.sort}
            selectHrefBase={base}
          />
        </div>

        <div className="space-y-6">
          {selected ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span>{selected.vendor ?? 'Expense'}</span>
                  <Badge
                    variant={
                      selected.status === 'APPROVED' || selected.status === 'REIMBURSED'
                        ? 'success'
                        : selected.status === 'REJECTED'
                          ? 'destructive'
                          : 'neutral'
                    }
                  >
                    {selected.status.charAt(0) + selected.status.slice(1).toLowerCase()}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {selected.incurredOn.toISOString().slice(0, 10)} ·{' '}
                  {selected.submittedBy?.user.name ?? 'Former member'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="tabular text-xl font-semibold">
                  {formatMoney(selected.amountMinor + selected.taxMinor, selected.currency)}
                </p>
                {selected.description ? (
                  <p className="text-muted-foreground whitespace-pre-wrap">
                    {selected.description}
                  </p>
                ) : null}
                {selected.category ? (
                  <p className="text-muted-foreground text-xs">
                    Category: {selected.category.name}
                  </p>
                ) : null}
                {selected.project ? (
                  <p className="text-muted-foreground text-xs">
                    Project: {selected.project.key} · {selected.project.name}
                  </p>
                ) : null}
                {selected.decisionNote ? (
                  <p className="text-muted-foreground text-xs">
                    Decision note: {selected.decisionNote}
                  </p>
                ) : null}

                {selected.status === 'DRAFT' &&
                selected.submittedByMembershipId === ctx.membershipId ? (
                  <SubmitExpenseButton orgSlug={orgSlug} expenseId={selected.id} />
                ) : null}

                {/*
                  The approve and reject controls are hidden for your own claim
                  because the service refuses it; hiding them avoids offering an
                  action that would only fail.
                */}
                {selected.status === 'SUBMITTED' &&
                selected.submittedByMembershipId !== ctx.membershipId &&
                ctx.canAny(['finance.expense.approve', 'finance.expense.reject']) ? (
                  <ExpenseDecisionControls
                    orgSlug={orgSlug}
                    expenseId={selected.id}
                    canApprove={ctx.can('finance.expense.approve')}
                    canReject={ctx.can('finance.expense.reject')}
                  />
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {options ? (
            <Card>
              <CardHeader>
                <CardTitle>New expense</CardTitle>
              </CardHeader>
              <CardContent>
                <ExpenseForm
                  orgSlug={orgSlug}
                  currency={ctx.org.currency}
                  categories={options.categories}
                  projects={options.projects}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
