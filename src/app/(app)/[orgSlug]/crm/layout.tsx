import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { CrmTabs } from '@/modules/crm/components/crm-tabs'

/**
 * CRM section guard.
 *
 * A member with no CRM permission at all gets 404 rather than an empty shell,
 * so the navigation and the routes agree.
 */
export default async function CrmLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const tabs = [
    { href: `/${orgSlug}/crm/pipeline`, label: 'Pipeline', show: ctx.can('crm.deal.read') },
    { href: `/${orgSlug}/crm/deals`, label: 'Deals', show: ctx.can('crm.deal.read') },
    { href: `/${orgSlug}/crm/leads`, label: 'Leads', show: ctx.can('crm.lead.read') },
    { href: `/${orgSlug}/crm/companies`, label: 'Companies', show: ctx.can('crm.company.read') },
    { href: `/${orgSlug}/crm/contacts`, label: 'Contacts', show: ctx.can('crm.contact.read') },
  ].filter((tab) => tab.show)

  if (tabs.length === 0) notFound()

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <CrmTabs tabs={tabs.map(({ href, label }) => ({ href, label }))} />
      {children}
    </div>
  )
}
