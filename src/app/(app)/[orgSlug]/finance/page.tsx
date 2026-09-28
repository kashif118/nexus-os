import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { getFinancialSummary } from '@/modules/finance/queries'

export const metadata: Metadata = { title: 'Finance' }

export default async function FinanceOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  // Someone who can only file expenses lands on the expenses tab instead.
  if (!ctx.can('finance.report.view')) {
    if (ctx.canAny(['finance.expense.read.any', 'finance.expense.read.own'])) {
      redirect(`/${orgSlug}/finance/expenses`)
    }
    notFound()
  }

  let summary: Awaited<ReturnType<typeof getFinancialSummary>>
  try {
    summary = await getFinancialSummary(ctx)
  } catch (error) {
    if (isAppError(error) && error.code === 'FORBIDDEN') notFound()
    throw error
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        description={`Cash movement since ${summary.periodStart.toISOString().slice(0, 10)}.`}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Revenue received"
          value={formatMoney(summary.revenueMinor, summary.currency)}
          detail="Payments banked, not invoices raised."
        />
        <Stat
          label="Approved expenses"
          value={formatMoney(summary.expensesMinor, summary.currency)}
          detail="Approved and reimbursed claims."
        />
        <Stat
          label="Net cash"
          value={formatMoney(summary.netMinor, summary.currency)}
          detail="In less out. Not profit — that needs accruals."
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Invoices by status</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.invoicesByStatus.length === 0 ? (
              <p className="text-muted-foreground text-sm">No invoices yet.</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {summary.invoicesByStatus.map((row) => (
                  <li key={row.status} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex items-center gap-2">
                      <Badge variant={row.status === 'OVERDUE' ? 'destructive' : 'neutral'}>
                        {row.status.charAt(0) + row.status.slice(1).toLowerCase()}
                      </Badge>
                      <span className="text-muted-foreground text-xs">{row.count}</span>
                    </span>
                    <span className="tabular font-medium">
                      {formatMoney(row.totalMinor, summary.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Outstanding</CardTitle>
            <CardDescription>Issued invoices still awaiting payment.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.outstanding.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing outstanding.</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {summary.outstanding.map((invoice) => (
                  <li key={invoice.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link
                        href={`/${orgSlug}/finance/invoices/${invoice.id}`}
                        className="font-medium hover:underline"
                      >
                        {invoice.number}
                      </Link>
                      <p className="text-muted-foreground truncate text-xs">
                        {invoice.company.name} · due {invoice.dueDate.toISOString().slice(0, 10)}
                      </p>
                    </div>
                    <span className="tabular font-medium">
                      {formatMoney(invoice.balanceMinor, invoice.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="tabular text-2xl font-semibold">{value}</p>
        <p className="text-muted-foreground text-xs">{detail}</p>
      </CardContent>
    </Card>
  )
}
