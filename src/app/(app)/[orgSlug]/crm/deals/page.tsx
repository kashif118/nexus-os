import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import { DealTable } from '@/modules/crm/components/crm-tables'
import { SearchInput } from '@/modules/crm/components/search-input'
import { listDeals } from '@/modules/crm/queries'
import { DEAL_SORT_FIELDS, DEAL_STATUSES } from '@/modules/crm/schema'

export const metadata: Metadata = { title: 'Deals' }

export default async function DealsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('crm.deal.read')) notFound()

  const resolved = await searchParams
  const listParams = parseListParams(resolved, {
    sortableFields: DEAL_SORT_FIELDS,
    defaultSort: 'createdAt',
  })

  const requestedStatus = Array.isArray(resolved.status) ? resolved.status[0] : resolved.status
  const status = DEAL_STATUSES.includes(requestedStatus as never) ? requestedStatus : undefined

  const page = await listDeals(ctx, listParams, { status })

  return (
    <div className="space-y-4">
      <PageHeader
        title="Deals"
        description="Opportunities moving through your pipelines."
        actions={
          ctx.can('crm.deal.create') ? (
            <Link href={`/${orgSlug}/crm/deals/new`} className={buttonVariants({ size: 'sm' })}>
              New deal
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search deals…" />
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter by status">
          <Link
            href={`/${orgSlug}/crm/deals`}
            className={`rounded-md px-2 py-1 ${!status ? 'bg-accent' : 'hover:bg-accent/60'}`}
          >
            All
          </Link>
          {DEAL_STATUSES.map((value) => (
            <Link
              key={value}
              href={`/${orgSlug}/crm/deals?status=${value}`}
              className={`rounded-md px-2 py-1 ${status === value ? 'bg-accent' : 'hover:bg-accent/60'}`}
            >
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </Link>
          ))}
        </nav>
      </div>

      <DealTable
        orgSlug={orgSlug}
        rows={page.items}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
        sort={listParams.sort}
        canSeeValue={ctx.can('crm.deal.value.view')}
      />
    </div>
  )
}
