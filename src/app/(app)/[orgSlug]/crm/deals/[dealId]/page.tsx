import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { ActivityTimeline } from '@/modules/crm/components/activity-timeline'
import { ActivityForm, DealForm } from '@/modules/crm/components/crm-forms'
import { CloseDealControls } from '@/modules/crm/components/deal-controls'
import { getDeal, getPickerOptions, listPipelines } from '@/modules/crm/queries'

export const metadata: Metadata = { title: 'Deal' }

export default async function DealDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; dealId: string }>
}) {
  const { orgSlug, dealId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let deal: Awaited<ReturnType<typeof getDeal>>
  try {
    deal = await getDeal(ctx, dealId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const [options, pipelines] = await Promise.all([getPickerOptions(ctx), listPipelines(ctx)])
  const canSeeValue = ctx.can('crm.deal.value.view')

  return (
    <div className="space-y-6">
      <PageHeader
        title={deal.title}
        description={deal.company?.name ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant={
                deal.status === 'WON'
                  ? 'success'
                  : deal.status === 'LOST'
                    ? 'destructive'
                    : 'neutral'
              }
            >
              {deal.status.charAt(0) + deal.status.slice(1).toLowerCase()}
            </Badge>
            {canSeeValue ? (
              <span className="tabular text-lg font-semibold">
                {formatMoney(deal.valueMinor, deal.currency)}
              </span>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {ctx.can('crm.deal.update') ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <DealForm
                  orgSlug={orgSlug}
                  options={options}
                  pipelines={pipelines}
                  currency={ctx.org.currency}
                  deal={deal}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <ActivityForm orgSlug={orgSlug} entityType="Deal" entityId={deal.id} />
              <ActivityTimeline activities={deal.activities} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Pipeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Pipeline" value={deal.pipeline.name} />
              <Row label="Stage" value={deal.stage.name} />
              <Row label="Probability" value={`${deal.stage.probability}%`} />
              {deal.expectedCloseDate ? (
                <Row
                  label="Expected close"
                  value={deal.expectedCloseDate.toISOString().slice(0, 10)}
                />
              ) : null}
              {deal.owner ? <Row label="Owner" value={deal.owner.user.name} /> : null}
              {deal.primaryContact ? (
                <Row
                  label="Contact"
                  value={
                    <Link
                      href={`/${orgSlug}/crm/contacts/${deal.primaryContact.id}`}
                      className="hover:underline"
                    >
                      {deal.primaryContact.firstName} {deal.primaryContact.lastName}
                    </Link>
                  }
                />
              ) : null}
              {deal.lostReason ? <Row label="Lost reason" value={deal.lostReason} /> : null}

              {deal.status === 'OPEN' && ctx.can('crm.deal.stage.move') ? (
                <CloseDealControls orgSlug={orgSlug} dealId={deal.id} />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Stage history</CardTitle>
            </CardHeader>
            <CardContent>
              {deal.history.length === 0 ? (
                <p className="text-muted-foreground text-sm">No moves recorded.</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {deal.history.map((entry) => (
                    <li key={entry.id} className="py-2">
                      <p>
                        {entry.fromStage?.name ?? 'Created'} → {entry.toStage.name}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {entry.changedAt.toISOString().slice(0, 10)}
                        {entry.durationSeconds !== null
                          ? ` · ${formatDuration(entry.durationSeconds)} in previous stage`
                          : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}`
  const hours = Math.floor(seconds / 3600)
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`
  return 'less than an hour'
}
