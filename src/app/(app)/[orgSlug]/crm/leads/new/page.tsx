import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { LeadForm } from '@/modules/crm/components/crm-forms'
import { getPickerOptions } from '@/modules/crm/queries'

export const metadata: Metadata = { title: 'New Lead' }

export default async function NewLeadPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('crm.lead.create')) notFound()

  const options = await getPickerOptions(ctx)

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="New lead" />
      <Card>
        <CardContent className="pt-5">
          <LeadForm orgSlug={orgSlug} options={options} />
        </CardContent>
      </Card>
    </div>
  )
}
