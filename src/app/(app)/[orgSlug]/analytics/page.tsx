import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { BarChart, ChangeBadge, TrendChart } from '@/components/data/chart'
import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { getAnalytics } from '@/modules/analytics/queries'
import { PERIODS } from '@/modules/analytics/periods'

export const metadata: Metadata = { title: 'Analytics' }

const PERIOD_LABELS: Record<string, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '12m': '12 months',
  ytd: 'Year to date',
}

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const resolved = await searchParams
  const requested = Array.isArray(resolved.period) ? resolved.period[0] : resolved.period

  let analytics: Awaited<ReturnType<typeof getAnalytics>>
  try {
    analytics = await getAnalytics(ctx, { period: requested, orgSlug })
  } catch (error) {
    if (isAppError(error) && error.code === 'FORBIDDEN') notFound()
    throw error
  }

  const format = (unit: string, value: number, valueMinor: bigint | null): string => {
    if (unit === 'money') {
      return valueMinor === null
        ? formatMoney(BigInt(Math.round(value * 100)), analytics.currency)
        : formatMoney(valueMinor, analytics.currency)
    }
    if (unit === 'percent') return `${Math.round(value)}%`
    if (unit === 'days') return `${Math.round(value)} days`
    return new Intl.NumberFormat('en').format(Math.round(value))
  }

  const moneyAxis = (value: number) =>
    formatMoney(BigInt(Math.round(value * 100)), analytics.currency)
  const countAxis = (value: number) => new Intl.NumberFormat('en').format(Math.round(value))

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Analytics"
        description={`${analytics.rangeLabel} · computed live from your records, in UTC.`}
      />

      <nav className="flex flex-wrap gap-1 text-xs" aria-label="Period">
        {PERIODS.map((period) => (
          <Link
            key={period}
            href={`/${orgSlug}/analytics?period=${period}`}
            aria-current={analytics.period === period ? 'true' : undefined}
            className={`rounded-md px-2.5 py-1 ${
              analytics.period === period ? 'bg-accent' : 'hover:bg-accent/60'
            }`}
          >
            {PERIOD_LABELS[period]}
          </Link>
        ))}
      </nav>

      {analytics.metrics.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">
              You do not have access to any metrics in this organization.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {analytics.metrics.map((metric) => {
          const body = (
            <>
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {metric.label}
              </p>
              <p className="tabular mt-1 text-2xl font-semibold">
                {format(metric.unit, metric.value, metric.valueMinor)}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <ChangeBadge
                  changePercent={metric.changePercent}
                  higherIsBetter={metric.higherIsBetter}
                />
                <span className="text-muted-foreground text-xs">vs previous period</span>
              </div>
            </>
          )

          return (
            <Card key={metric.key}>
              <CardContent className="pt-6">
                {metric.drilldown ? (
                  <Link href={metric.drilldown} className="block hover:underline">
                    {body}
                  </Link>
                ) : (
                  body
                )}
                <p className="text-muted-foreground mt-2 text-xs">{metric.description}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {analytics.series.map((series) => (
          <Card key={series.key}>
            <CardHeader>
              <CardTitle className="text-base">{series.label}</CardTitle>
              <CardDescription>Over {analytics.rangeLabel.toLowerCase()}.</CardDescription>
            </CardHeader>
            <CardContent>
              <TrendChart
                points={series.points}
                format={series.unit === 'money' ? moneyAxis : countAxis}
                ariaLabel={`${series.label} over ${analytics.rangeLabel.toLowerCase()}`}
              />
            </CardContent>
          </Card>
        ))}
      </div>

      {analytics.metrics.some((metric) => metric.unit === 'count') ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where things stand</CardTitle>
            <CardDescription>
              Point-in-time counts, as of now — not totals for the period.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              points={analytics.metrics
                .filter((metric) => metric.unit === 'count')
                .map((metric) => ({ label: metric.label, value: metric.value }))}
              format={countAxis}
              ariaLabel="Current counts across the organization"
            />
          </CardContent>
        </Card>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Every figure here is computed from your own records when the page loads. Periods are
        measured in UTC, and a change is compared against the equivalent preceding window of the
        same length.
      </p>
    </div>
  )
}
