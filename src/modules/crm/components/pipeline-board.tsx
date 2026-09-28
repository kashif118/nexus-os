'use client'

import Link from 'next/link'
import { useOptimistic, useState, useTransition } from 'react'

import { EmptyState } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

import { moveDealAction } from '../actions'

/**
 * The pipeline board.
 *
 * Drag and drop uses the native HTML5 API rather than a library: a card here
 * carries no complex ordering — dropping it on a column is a single stage
 * change — so a drag library would add weight for nothing. Keyboard users get an
 * explicit stage selector on every card, which is the accessible path and also
 * the one that works on touch.
 *
 * The move is applied optimistically and reconciled by the server action, so the
 * board feels immediate but the database remains the source of truth.
 */

export interface BoardStage {
  id: string
  name: string
  type: string
  probability: number
}

export interface BoardDeal {
  id: string
  title: string
  valueMinor: bigint
  currency: string
  stageId: string
  expectedCloseDate: Date | null
  company: { id: string; name: string } | null
  owner: { user: { name: string } } | null
}

export function PipelineBoard({
  orgSlug,
  stages,
  deals,
  canMove,
  canSeeValue,
}: {
  orgSlug: string
  stages: BoardStage[]
  deals: BoardDeal[]
  canMove: boolean
  canSeeValue: boolean
}) {
  const [, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<string | null>(null)

  const [optimisticDeals, applyMove] = useOptimistic(
    deals,
    (current, move: { dealId: string; stageId: string }) =>
      current.map((deal) => (deal.id === move.dealId ? { ...deal, stageId: move.stageId } : deal)),
  )

  function move(dealId: string, stageId: string) {
    const deal = optimisticDeals.find((entry) => entry.id === dealId)
    if (!deal || deal.stageId === stageId) return

    setError(null)
    startTransition(async () => {
      applyMove({ dealId, stageId })

      const formData = new FormData()
      formData.set('dealId', dealId)
      formData.set('stageId', stageId)

      const result = await moveDealAction(orgSlug, null, formData)
      // The optimistic state is discarded when the transition ends; a failure
      // surfaces here and the server value is what renders.
      if (result && !result.ok) setError(result.error.message)
    })
  }

  if (stages.length === 0) {
    return <EmptyState title="This pipeline has no stages" />
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <div
        className="grid grid-flow-col gap-3 overflow-x-auto pb-2"
        style={{ gridAutoColumns: '17rem' }}
      >
        {stages.map((stage) => {
          const stageDeals = optimisticDeals.filter((deal) => deal.stageId === stage.id)
          const stageTotal = stageDeals.reduce((sum, deal) => sum + deal.valueMinor, 0n)
          const currency = stageDeals[0]?.currency ?? 'USD'

          return (
            <section
              key={stage.id}
              aria-label={stage.name}
              onDragOver={(event) => {
                if (!canMove || !dragging) return
                event.preventDefault()
                setOverStage(stage.id)
              }}
              onDragLeave={() => setOverStage((current) => (current === stage.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                setOverStage(null)
                if (canMove && dragging) move(dragging, stage.id)
                setDragging(null)
              }}
              className={cn(
                'bg-muted/40 flex min-h-64 flex-col rounded-lg border p-2 transition-colors',
                overStage === stage.id && 'border-primary bg-accent/50',
              )}
            >
              <header className="flex items-baseline justify-between gap-2 px-1 pb-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium">{stage.name}</h3>
                  {canSeeValue ? (
                    <p className="text-muted-foreground tabular text-xs">
                      {formatMoney(stageTotal, currency, { compact: true })}
                    </p>
                  ) : null}
                </div>
                <span className="text-muted-foreground tabular text-xs">{stageDeals.length}</span>
              </header>

              <ul className="flex-1 space-y-2">
                {stageDeals.map((deal) => (
                  <li key={deal.id}>
                    <article
                      draggable={canMove}
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => {
                        setDragging(null)
                        setOverStage(null)
                      }}
                      className={cn(
                        'bg-card space-y-1.5 rounded-md border p-2.5 shadow-[var(--shadow-sm)]',
                        canMove && 'cursor-grab active:cursor-grabbing',
                        dragging === deal.id && 'opacity-50',
                      )}
                    >
                      <Link
                        href={`/${orgSlug}/crm/deals/${deal.id}`}
                        className="block text-sm font-medium hover:underline"
                      >
                        {deal.title}
                      </Link>

                      {deal.company ? (
                        <p className="text-muted-foreground truncate text-xs">
                          {deal.company.name}
                        </p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-1.5">
                        {canSeeValue ? (
                          <Badge variant="neutral">
                            {formatMoney(deal.valueMinor, deal.currency)}
                          </Badge>
                        ) : null}
                        {deal.expectedCloseDate ? (
                          <span className="text-muted-foreground text-xs">
                            {deal.expectedCloseDate.toISOString().slice(0, 10)}
                          </span>
                        ) : null}
                      </div>

                      {canMove ? (
                        <label className="block">
                          <span className="sr-only">Move {deal.title} to another stage</span>
                          <select
                            value={deal.stageId}
                            onChange={(event) => move(deal.id, event.target.value)}
                            className="border-input bg-background mt-1 h-7 w-full rounded-md border px-1.5 text-xs"
                          >
                            {stages.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
