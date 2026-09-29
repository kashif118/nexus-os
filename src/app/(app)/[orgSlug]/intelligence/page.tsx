import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { Assistant } from '@/modules/ai/components/assistant'
import { InsightList } from '@/modules/ai/components/insight-cards'
import { aiStatus, getUsage, listInsights } from '@/modules/ai/queries'
import { formatUsd } from '@/modules/ai/gateway'

export const metadata: Metadata = { title: 'Intelligence' }

/**
 * The Intelligence Center.
 *
 * Two halves with very different guarantees, and the page says which is which:
 *
 * - **Findings** are computed from the organization's own rows and cite them.
 *   They work with no AI provider configured, and they cannot be wrong in the
 *   way a generated claim can be wrong.
 * - **The assistant** needs a provider. When there isn't one, it says so rather
 *   than accepting a question it cannot answer.
 */
export default async function IntelligencePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('ai.use')) notFound()

  const [insights, usage] = await Promise.all([listInsights(ctx), getUsage(ctx)])
  const status = aiStatus()

  const suggestions = [
    'Which projects are off track, and why?',
    'What is outstanding on invoices right now?',
    'Which deals have not moved in a month?',
    'What is assigned to me this week?',
  ]

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Intelligence"
        description="Findings computed from your data, and an assistant that can only see what you can."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Assistant</CardTitle>
            <CardDescription>
              It answers by looking things up through the same permissions you have. It cannot read
              another organization&rsquo;s data, and it has no direct database access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Assistant orgSlug={orgSlug} configured={status.configured} suggestions={suggestions} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>This month</CardTitle>
            <CardDescription>Estimated, from published token prices.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <dl className="space-y-1">
              <Row label="Spent" value={formatUsd(usage.budget.usedMicros)} />
              <Row label="Budget" value={formatUsd(usage.budget.limitMicros)} />
              <Row label="Calls" value={String(usage.history[0]?.calls ?? 0)} />
            </dl>

            <div
              className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
              role="img"
              aria-label={`${Math.round((usage.budget.usedMicros / usage.budget.limitMicros) * 100)}% of the monthly budget used`}
            >
              <div
                className={
                  usage.budget.withinBudget ? 'bg-primary h-full' : 'bg-destructive h-full'
                }
                style={{
                  width: `${Math.min(100, Math.round((usage.budget.usedMicros / usage.budget.limitMicros) * 100))}%`,
                }}
              />
            </div>

            <p className="text-muted-foreground text-xs">
              Calls are refused once the budget is reached, rather than discovered on an invoice.
            </p>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What needs attention</h2>
        <InsightList
          orgSlug={orgSlug}
          insights={insights.map((insight) => ({
            id: insight.id,
            kind: insight.kind,
            severity: insight.severity,
            title: insight.title,
            detail: insight.detail,
            evidence: Array.isArray(insight.evidence)
              ? (insight.evidence as Array<{
                  entityType: string
                  entityId: string
                  label: string
                }>)
              : [],
            computedAt: insight.computedAt,
          }))}
          canRefresh={ctx.can('ai.use')}
        />
      </section>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  )
}
