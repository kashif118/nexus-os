import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { PlanControls } from '@/modules/billing/components/plan-controls'
import { formatBytes, formatLimit } from '@/modules/billing/plans'
import { getBillingOverview } from '@/modules/billing/queries'
import { relativeTime } from '@/lib/format'

export const metadata: Metadata = { title: 'Billing' }

/** A usage row with its limit, shown as a bar. */
function UsageRow({
  label,
  used,
  limit,
  format,
}: {
  label: string
  used: number
  limit: number
  format: (value: number) => string
}) {
  const unlimited = limit === Infinity
  const percent = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100))
  const tight = !unlimited && percent >= 80

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="tabular text-muted-foreground">
          {format(used)} of {unlimited ? 'unlimited' : format(limit)}
        </span>
      </div>
      {unlimited ? null : (
        <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
          <div
            className={tight ? 'h-full bg-amber-500' : 'bg-primary h-full'}
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>
      )}
    </div>
  )
}

export default async function BillingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const overview = await getBillingOverview(ctx)
  if (!overview.canManage && !ctx.can('organization.read')) notFound()

  const { subscription, usage, plan } = { ...overview, plan: overview.usage.plan }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        title="Plan and usage"
        description="What this organization is entitled to, and how much of it is in use."
        actions={
          <Badge variant={subscription?.status === 'PAST_DUE' ? 'warning' : 'neutral'}>
            {plan.name}
          </Badge>
        }
      />

      {subscription?.status === 'PAST_DUE' ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm">
              The last payment did not go through. Nothing has been restricted — access continues to
              the end of the paid period so nobody loses their own work over a card problem.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Usage</CardTitle>
            <CardDescription>
              Counted live from your own records, and checked before an operation rather than after
              it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <UsageRow
              label="Members"
              used={usage.seats.used}
              limit={usage.seats.limit}
              format={formatLimit}
            />
            <UsageRow
              label="Projects"
              used={usage.projects.used}
              limit={usage.projects.limit}
              format={formatLimit}
            />
            <UsageRow
              label="Documents"
              used={usage.storageBytes.used}
              limit={usage.storageBytes.limit}
              format={formatBytes}
            />
            <UsageRow
              label="Workflow runs this month"
              used={usage.workflowRuns.used}
              limit={usage.workflowRuns.limit}
              format={formatLimit}
            />
            <UsageRow
              label="AI spend this month"
              used={usage.aiBudgetMicros.used}
              limit={usage.aiBudgetMicros.limit}
              format={(value) => `$${(Math.round(value / 10_000) / 100).toFixed(2)}`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Subscription</CardTitle>
            <CardDescription>
              {overview.configured
                ? 'Billing runs through a payment provider. The plan follows what the provider reports.'
                : 'This deployment does not take payments. An owner sets the plan directly; billing, if any, happens elsewhere.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="space-y-1">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Plan</dt>
                <dd className="font-medium">{plan.name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{(subscription?.status ?? 'NONE').toLowerCase()}</dd>
              </div>
              {subscription?.currentPeriodEnd ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Renews</dt>
                  <dd>{subscription.currentPeriodEnd.toISOString().slice(0, 10)}</dd>
                </div>
              ) : null}
              {subscription?.setManuallyAt ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Set by hand</dt>
                  <dd>{relativeTime(subscription.setManuallyAt)}</dd>
                </div>
              ) : null}
            </dl>

            {subscription?.setManuallyAt ? (
              <p className="text-muted-foreground text-xs">
                This plan was set by an administrator rather than by an observed payment. It is
                recorded that way deliberately, so reconciliation can tell the two apart.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Plans</h2>

        <div className="grid gap-4 md:grid-cols-3">
          {overview.plans.map((option) => (
            <Card key={option.key} className={option.key === plan.key ? 'border-primary' : ''}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{option.name}</CardTitle>
                  {option.key === plan.key ? <Badge variant="success">Current</Badge> : null}
                </div>
                <CardDescription>{option.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="tabular text-2xl font-semibold">
                  {option.monthlyPriceMinor === 0
                    ? 'Free'
                    : `${formatMoney(BigInt(option.monthlyPriceMinor), option.currency)}`}
                  {option.monthlyPriceMinor > 0 ? (
                    <span className="text-muted-foreground text-sm font-normal"> / month</span>
                  ) : null}
                </p>

                <ul className="text-muted-foreground space-y-1 text-xs">
                  {option.highlights.map((highlight) => (
                    <li key={highlight}>{highlight}</li>
                  ))}
                </ul>

                {overview.canManage ? (
                  <PlanControls
                    orgSlug={orgSlug}
                    planKey={option.key}
                    current={option.key === plan.key}
                    configured={overview.configured}
                    hasBillingAccount={Boolean(subscription?.providerCustomerId)}
                  />
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>

        {overview.configured ? (
          <p className="text-muted-foreground text-xs">
            Prices shown here are for display. What is charged is whatever the payment provider
            holds, which is the only authority for a price.
          </p>
        ) : null}
      </section>

      {overview.canManage && overview.events.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Provider events</CardTitle>
            <CardDescription>
              Every webhook received, whether or not it changed anything. A repeat is ignored.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {overview.events.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 py-2">
                  <code className="font-mono text-xs">{event.type}</code>
                  <span className="text-muted-foreground text-xs">
                    {event.error ? `failed: ${event.error}` : relativeTime(event.receivedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
