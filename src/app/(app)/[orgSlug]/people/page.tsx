import type { Metadata } from 'next'

import { EmptyState, PageHeader } from '@/components/feedback/states'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { SearchInput } from '@/modules/crm/components/search-input'
import { PeopleDirectory } from '@/modules/people/components/people-ui'
import { listPeople } from '@/modules/people/queries'

export const metadata: Metadata = { title: 'People' }

export default async function PeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ q?: string }>
}) {
  const { orgSlug } = await params
  const { q } = await searchParams
  const ctx = await requireCtxPage(orgSlug)

  const people = await listPeople(ctx, q)

  return (
    <div className="space-y-4">
      <PageHeader title="People" description="Everyone with access to this organization." />
      <SearchInput placeholder="Search people…" />

      {people.length === 0 ? (
        <EmptyState
          title="Nobody matches"
          description="Try a different search, or invite someone from Members."
        />
      ) : (
        <PeopleDirectory
          orgSlug={orgSlug}
          people={people.map((person) => ({
            membershipId: person.membershipId,
            name: person.name,
            email: person.email,
            position: person.position,
            departmentName: person.departmentName,
            skills: person.skills,
          }))}
        />
      )}
    </div>
  )
}
