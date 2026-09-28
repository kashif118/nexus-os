import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import { ContactTable } from '@/modules/crm/components/crm-tables'
import { SearchInput } from '@/modules/crm/components/search-input'
import { listContacts } from '@/modules/crm/queries'
import { CONTACT_SORT_FIELDS } from '@/modules/crm/schema'

export const metadata: Metadata = { title: 'Contacts' }

export default async function ContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('crm.contact.read')) notFound()

  const listParams = parseListParams(await searchParams, {
    sortableFields: CONTACT_SORT_FIELDS,
    defaultSort: 'lastName',
    defaultDirection: 'asc',
  })

  const page = await listContacts(ctx, listParams)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Contacts"
        description="The people you deal with at each company."
        actions={
          ctx.can('crm.contact.create') ? (
            <Link href={`/${orgSlug}/crm/contacts/new`} className={buttonVariants({ size: 'sm' })}>
              New contact
            </Link>
          ) : null
        }
      />

      <SearchInput placeholder="Search contacts…" />

      <ContactTable
        orgSlug={orgSlug}
        rows={page.items}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
        sort={listParams.sort}
      />
    </div>
  )
}
