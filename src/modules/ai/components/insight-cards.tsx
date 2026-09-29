'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { EmptyState } from '@/components/feedback/states'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { dismissInsightAction, refreshInsightsAction, type FormState } from '../actions'

export interface InsightCard {
  id: string
  kind: string
  severity: string
  title: string
  detail: string
  evidence: Array<{ entityType: string; entityId: string; label: string }>
  computedAt: Date
}

const tone = (severity: string) =>
  severity === 'CRITICAL' ? 'destructive' : severity === 'WARNING' ? 'warning' : 'neutral'

/** Where a cited record lives, so evidence is one click from the finding. */
function hrefFor(orgSlug: string, entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'Invoice':
      return `/${orgSlug}/finance/invoices/${entityId}`
    case 'Expense':
      return `/${orgSlug}/finance/expenses?expense=${entityId}`
    case 'Deal':
      return `/${orgSlug}/crm/deals/${entityId}`
    case 'Project':
      return `/${orgSlug}/projects/${entityId}`
    case 'Membership':
      return `/${orgSlug}/people/${entityId}`
    default:
      return null
  }
}

export function InsightList({
  orgSlug,
  insights,
  canRefresh,
}: {
  orgSlug: string
  insights: InsightCard[]
  canRefresh: boolean
}) {
  const [refreshState, refresh] = useActionState<FormState, FormData>(
    refreshInsightsAction.bind(null, orgSlug),
    null,
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          Every finding below is computed from your own records and cites them. Nothing here is
          generated.
        </p>
        {canRefresh ? (
          <form action={refresh} className="flex items-center gap-2">
            {refreshState?.ok && refreshState.data.message ? (
              <span className="text-muted-foreground text-xs">{refreshState.data.message}</span>
            ) : null}
            <SubmitButton size="sm" variant="outline" pendingLabel="Checking…">
              Recheck
            </SubmitButton>
          </form>
        ) : null}
      </div>

      {refreshState && !refreshState.ok ? (
        <Alert variant="destructive">{refreshState.error.message}</Alert>
      ) : null}

      {insights.length === 0 ? (
        <EmptyState
          title="Nothing needs your attention"
          description="Overdue invoices, stalled deals, at-risk projects, expense backlogs and workload imbalance are all checked. None of them applies right now."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {insights.map((insight) => (
            <InsightCardView key={insight.id} orgSlug={orgSlug} insight={insight} />
          ))}
        </div>
      )}
    </div>
  )
}

function InsightCardView({ orgSlug, insight }: { orgSlug: string; insight: InsightCard }) {
  const [state, dismiss] = useActionState<FormState, FormData>(
    dismissInsightAction.bind(null, orgSlug),
    null,
  )

  if (state?.ok) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm">{insight.title}</CardTitle>
          <Badge variant={tone(insight.severity)}>
            {insight.severity.charAt(0) + insight.severity.slice(1).toLowerCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">{insight.detail}</p>

        <div>
          <p className="text-xs font-medium">Based on</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {insight.evidence.slice(0, 6).map((item) => {
              const href = hrefFor(orgSlug, item.entityType, item.entityId)
              return (
                <li key={`${item.entityType}-${item.entityId}`}>
                  {href ? (
                    <Link href={href} className="text-muted-foreground hover:underline">
                      {item.label}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{item.label}</span>
                  )}
                </li>
              )
            })}
            {insight.evidence.length > 6 ? (
              <li className="text-muted-foreground">and {insight.evidence.length - 6} more</li>
            ) : null}
          </ul>
        </div>

        <form action={dismiss}>
          <input type="hidden" name="id" value={insight.id} />
          <SubmitButton size="sm" variant="ghost" pendingLabel="Dismissing…">
            Dismiss
          </SubmitButton>
        </form>

        {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      </CardContent>
    </Card>
  )
}
