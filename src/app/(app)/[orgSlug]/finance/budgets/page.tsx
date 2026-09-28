import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { BudgetForm, CategoryForm } from '@/modules/finance/components/expense-forms'
import { getFinanceFormOptions, listBudgets } from '@/modules/finance/queries'

export const metadata: Metadata = { title: 'Budgets' }

export default async function BudgetsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('finance.budget.read')) notFound()

  const [budgets, options] = await Promise.all([listBudgets(ctx), getFinanceFormOptions(ctx)])
  const canManage = ctx.can('finance.budget.manage')

  const projectName = new Map(options.projects.map((p) => [p.id, `${p.key} · ${p.name}`]))
  const categoryName = new Map(options.categories.map((c) => [c.id, c.name]))

  const describeScope = (scopeType: string, scopeId: string | null) => {
    if (!scopeId) return 'Whole organization'
    if (scopeType === 'PROJECT') return projectName.get(scopeId) ?? 'Project'
    if (scopeType === 'CATEGORY') return categoryName.get(scopeId) ?? 'Category'
    return scopeType.charAt(0) + scopeType.slice(1).toLowerCase()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budgets"
        description="Planned spend per period. Actuals come from approved expenses."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Current budgets</CardTitle>
          </CardHeader>
          <CardContent>
            {budgets.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No budgets set. A budget is a ceiling you choose, not something the system infers.
              </p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {budgets.map((budget) => (
                  <li key={budget.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {describeScope(budget.scopeType, budget.scopeId)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {budget.periodStart.toISOString().slice(0, 10)} –{' '}
                        {budget.periodEnd.toISOString().slice(0, 10)}
                      </p>
                    </div>
                    <span className="tabular font-medium">
                      {formatMoney(budget.amountMinor, budget.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {canManage ? (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>New budget</CardTitle>
                <CardDescription>The end date must be on or after the start.</CardDescription>
              </CardHeader>
              <CardContent>
                <BudgetForm
                  orgSlug={orgSlug}
                  currency={ctx.org.currency}
                  projects={options.projects}
                  categories={options.categories}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Expense categories</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {options.categories.length > 0 ? (
                  <ul className="text-muted-foreground flex flex-wrap gap-2 text-xs">
                    {options.categories.map((category) => (
                      <li key={category.id} className="bg-muted rounded-md px-2 py-1">
                        {category.name}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <CategoryForm orgSlug={orgSlug} />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  )
}
