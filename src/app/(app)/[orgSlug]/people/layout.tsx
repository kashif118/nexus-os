import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { CrmTabs } from '@/modules/crm/components/crm-tabs'

export default async function PeopleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('people.read')) notFound()

  const tabs = [
    { href: `/${orgSlug}/people`, label: 'Directory' },
    { href: `/${orgSlug}/people/teams`, label: 'Teams' },
    ...(ctx.can('people.workload.view')
      ? [{ href: `/${orgSlug}/people/workload`, label: 'Workload' }]
      : []),
  ]

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <CrmTabs tabs={tabs} />
      {children}
    </div>
  )
}
