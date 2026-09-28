import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import { SearchInput } from '@/modules/crm/components/search-input'
import { InvoiceTable } from '@/modules/finance/components/finance-tables'
import { RefreshStatusesButton } from '@/modules/finance/components/refresh-statuses'
import { listInvoices } from '@/modules/finance/queries'
import { INVOICE_SORT_FIELDS, INVOICE_STATUSES } from '@/modules/finance/schema'

export const metadata: Metadata = { title: 'Invoices' }

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('finance.invoice.read')) notFound()

  const resolved = await searchParams
  const listParams = parseListParams(resolved, {
    sortableFields: INVOICE_SORT_FIELDS,
    defaultSort: 'issueDate',
    defaultDirection: 'desc',
  })

  const requested = Array.isArray(resolved.status) ? resolved.status[0] : resolved.status
  const status = INVOICE_STATUSES.includes(requested as never) ? requested : undefined

  const page = await listInvoices(ctx, listParams, { status })

  return (
    <div className="space-y-4">
      <PageHeader
        title="Invoices"
        description="What you have billed, and what is still owed."
        actions={
          <div className="flex items-center gap-2">
            {ctx.can('finance.invoice.update') ? <RefreshStatusesButton orgSlug={orgSlug} /> : null}
            {ctx.can('finance.invoice.create') ? (
              <Link
                href={`/${orgSlug}/finance/invoices/new`}
                className={buttonVariants({ size: 'sm' })}
              >
                New invoice
              </Link>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search by number or client…" />
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter by status">
          <Link
            href={`/${orgSlug}/finance/invoices`}
            className={`rounded-md px-2 py-1 ${!status ? 'bg-accent' : 'hover:bg-accent/60'}`}
          >
            All
          </Link>
          {INVOICE_STATUSES.map((value) => (
            <Link
              key={value}
              href={`/${orgSlug}/finance/invoices?status=${value}`}
              className={`rounded-md px-2 py-1 ${status === value ? 'bg-accent' : 'hover:bg-accent/60'}`}
            >
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </Link>
          ))}
        </nav>
      </div>

      <InvoiceTable
        orgSlug={orgSlug}
        rows={page.items}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
        sort={listParams.sort}
      />
    </div>
  )
}
