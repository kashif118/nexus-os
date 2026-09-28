import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { InvoiceEditor } from '@/modules/finance/components/invoice-editor'
import { getFinanceFormOptions } from '@/modules/finance/queries'

export const metadata: Metadata = { title: 'New invoice' }

export default async function NewInvoicePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('finance.invoice.create')) notFound()

  const options = await getFinanceFormOptions(ctx)

  return (
    <div className="space-y-6">
      <PageHeader
        title="New invoice"
        description="Created as a draft. Nothing is issued until you say so."
      />

      <Card>
        <CardContent className="pt-6">
          <InvoiceEditor
            orgSlug={orgSlug}
            currency={ctx.org.currency}
            options={{ companies: options.companies, projects: options.projects }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
