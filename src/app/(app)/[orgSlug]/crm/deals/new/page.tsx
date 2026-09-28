import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { DealForm } from '@/modules/crm/components/crm-forms'
import { getPickerOptions, listPipelines } from '@/modules/crm/queries'

export const metadata: Metadata = { title: 'New Deal' }

export default async function NewDealPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('crm.deal.create')) notFound()

  const [options, pipelines] = await Promise.all([getPickerOptions(ctx), listPipelines(ctx)])

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="New deal" />
      <Card>
        <CardContent className="pt-5">
          <DealForm
            orgSlug={orgSlug}
            options={options}
            pipelines={pipelines}
            currency={ctx.org.currency}
          />
        </CardContent>
      </Card>
    </div>
  )
}
