import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { CrmTabs } from '@/modules/crm/components/crm-tabs'

export default async function FinanceLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const tabs = [
    ...(ctx.can('finance.report.view') ? [{ href: `/${orgSlug}/finance`, label: 'Overview' }] : []),
    ...(ctx.can('finance.invoice.read')
      ? [{ href: `/${orgSlug}/finance/invoices`, label: 'Invoices' }]
      : []),
    ...(ctx.canAny(['finance.expense.read.any', 'finance.expense.read.own'])
      ? [{ href: `/${orgSlug}/finance/expenses`, label: 'Expenses' }]
      : []),
    ...(ctx.can('finance.budget.read')
      ? [{ href: `/${orgSlug}/finance/budgets`, label: 'Budgets' }]
      : []),
  ]

  if (tabs.length === 0) notFound()

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <CrmTabs tabs={tabs} />
      {children}
    </div>
  )
}
