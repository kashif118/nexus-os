import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import { LeadTable } from '@/modules/crm/components/crm-tables'
import { SearchInput } from '@/modules/crm/components/search-input'
import { listLeads } from '@/modules/crm/queries'
import { LEAD_SORT_FIELDS, LEAD_STATUSES } from '@/modules/crm/schema'

export const metadata: Metadata = { title: 'Leads' }

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('crm.lead.read')) notFound()

  const resolved = await searchParams
  const listParams = parseListParams(resolved, {
    sortableFields: LEAD_SORT_FIELDS,
    defaultSort: 'createdAt',
  })

  // Validated against the enum rather than passed through, so a crafted value
  // cannot reach the query.
  const requestedStatus = Array.isArray(resolved.status) ? resolved.status[0] : resolved.status
  const status = LEAD_STATUSES.includes(requestedStatus as never) ? requestedStatus : undefined

  const page = await listLeads(ctx, listParams, { status })

  return (
    <div className="space-y-4">
      <PageHeader
        title="Leads"
        description="Enquiries you have not yet qualified."
        actions={
          ctx.can('crm.lead.create') ? (
            <Link href={`/${orgSlug}/crm/leads/new`} className={buttonVariants({ size: 'sm' })}>
              New lead
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search leads…" />
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter by status">
          <Link
            href={`/${orgSlug}/crm/leads`}
            className={`rounded-md px-2 py-1 ${!status ? 'bg-accent' : 'hover:bg-accent/60'}`}
          >
            All
          </Link>
          {LEAD_STATUSES.map((value) => (
            <Link
              key={value}
              href={`/${orgSlug}/crm/leads?status=${value}`}
              className={`rounded-md px-2 py-1 ${status === value ? 'bg-accent' : 'hover:bg-accent/60'}`}
            >
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </Link>
          ))}
        </nav>
      </div>

      <LeadTable
        orgSlug={orgSlug}
        rows={page.items}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
        sort={listParams.sort}
      />
    </div>
  )
}
