import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import { CompanyTable } from '@/modules/crm/components/crm-tables'
import { SearchInput } from '@/modules/crm/components/search-input'
import { listCompanies } from '@/modules/crm/queries'
import { COMPANY_SORT_FIELDS } from '@/modules/crm/schema'

export const metadata: Metadata = { title: 'Companies' }

export default async function CompaniesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('crm.company.read')) notFound()

  // Sort and page come from the URL and are validated against an allowlist, so
  // an arbitrary column name can never reach the ORM.
  const listParams = parseListParams(await searchParams, {
    sortableFields: COMPANY_SORT_FIELDS,
    defaultSort: 'name',
    defaultDirection: 'asc',
  })

  const page = await listCompanies(ctx, listParams)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Companies"
        description="The organizations you sell to and deliver for."
        actions={
          ctx.can('crm.company.create') ? (
            <Link href={`/${orgSlug}/crm/companies/new`} className={buttonVariants({ size: 'sm' })}>
              New company
            </Link>
          ) : null
        }
      />

      <SearchInput placeholder="Search companies…" />

      <CompanyTable
        orgSlug={orgSlug}
        rows={page.items}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
        sort={listParams.sort}
      />
    </div>
  )
}
