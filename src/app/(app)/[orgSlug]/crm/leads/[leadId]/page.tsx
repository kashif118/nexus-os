import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { ActivityTimeline } from '@/modules/crm/components/activity-timeline'
import { ActivityForm, LeadForm } from '@/modules/crm/components/crm-forms'
import { ConvertLeadControls } from '@/modules/crm/components/deal-controls'
import { getLead, getPickerOptions } from '@/modules/crm/queries'

export const metadata: Metadata = { title: 'Lead' }

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; leadId: string }>
}) {
  const { orgSlug, leadId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let lead: Awaited<ReturnType<typeof getLead>>
  try {
    lead = await getLead(ctx, leadId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const options = await getPickerOptions(ctx)

  return (
    <div className="space-y-6">
      <PageHeader
        title={lead.name}
        description={lead.companyName ?? undefined}
        actions={<Badge variant="neutral">{titleCase(lead.status)}</Badge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {ctx.can('crm.lead.update') ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <LeadForm orgSlug={orgSlug} options={options} lead={lead} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <ActivityForm orgSlug={orgSlug} entityType="Lead" entityId={lead.id} />
              <ActivityTimeline activities={lead.activities} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {lead.convertedAt ? (
            <Card>
              <CardHeader>
                <CardTitle>Converted</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">
                  Converted on {lead.convertedAt.toISOString().slice(0, 10)}.
                </p>
                {lead.convertedCompanyId ? (
                  <Link
                    href={`/${orgSlug}/crm/companies/${lead.convertedCompanyId}`}
                    className="block hover:underline"
                  >
                    View company →
                  </Link>
                ) : null}
                {lead.convertedContactId ? (
                  <Link
                    href={`/${orgSlug}/crm/contacts/${lead.convertedContactId}`}
                    className="block hover:underline"
                  >
                    View contact →
                  </Link>
                ) : null}
                {lead.convertedDealId ? (
                  <Link
                    href={`/${orgSlug}/crm/deals/${lead.convertedDealId}`}
                    className="block hover:underline"
                  >
                    View deal →
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ) : ctx.can('crm.lead.convert') ? (
            <Card>
              <CardHeader>
                <CardTitle>Convert</CardTitle>
              </CardHeader>
              <CardContent>
                <ConvertLeadControls
                  orgSlug={orgSlug}
                  leadId={lead.id}
                  leadName={lead.name}
                  currency={ctx.org.currency}
                  canCreateDeal={ctx.can('crm.deal.create')}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Source" value={titleCase(lead.source)} />
              <Row label="Score" value={String(lead.score)} />
              {lead.email ? <Row label="Email" value={lead.email} /> : null}
              {lead.phone ? <Row label="Phone" value={lead.phone} /> : null}
              {lead.owner ? <Row label="Owner" value={lead.owner.user.name} /> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
