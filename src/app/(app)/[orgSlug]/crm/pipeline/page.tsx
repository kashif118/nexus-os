import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EmptyState, PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { PipelineBoard } from '@/modules/crm/components/pipeline-board'
import { ensureDefaultPipeline, getPipelineBoard } from '@/modules/crm/queries'

export const metadata: Metadata = { title: 'Pipeline' }

export default async function PipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ pipeline?: string }>
}) {
  const { orgSlug } = await params
  const { pipeline: pipelineId } = await searchParams
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('crm.deal.read')) notFound()

  // An organization cannot hold a deal without a pipeline, so the default is
  // created on first visit rather than requiring a setup step. Only attempted
  // for someone who could create one anyway.
  if (ctx.can('crm.deal.create')) await ensureDefaultPipeline(ctx)

  const board = await getPipelineBoard(ctx, pipelineId)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pipeline"
        description={
          board.pipeline
            ? `${board.deals.length} open deal${board.deals.length === 1 ? '' : 's'} in ${board.pipeline.name}.`
            : 'Deals move through stages here.'
        }
        actions={
          ctx.can('crm.deal.create') ? (
            <Link href={`/${orgSlug}/crm/deals/new`} className={buttonVariants({ size: 'sm' })}>
              New deal
            </Link>
          ) : null
        }
      />

      {board.pipelines.length > 1 ? (
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Pipelines">
          {board.pipelines.map((entry) => (
            <Link
              key={entry.id}
              href={`/${orgSlug}/crm/pipeline?pipeline=${entry.id}`}
              className={`rounded-md px-2 py-1 ${
                entry.id === board.pipeline?.id ? 'bg-accent' : 'hover:bg-accent/60'
              }`}
            >
              {entry.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {board.pipeline ? (
        <PipelineBoard
          orgSlug={orgSlug}
          stages={board.pipeline.stages}
          deals={board.deals}
          canMove={ctx.can('crm.deal.stage.move')}
          canSeeValue={ctx.can('crm.deal.value.view')}
        />
      ) : (
        <EmptyState
          title="No pipeline yet"
          description="A pipeline holds the stages a deal moves through on its way to won or lost."
        />
      )}
    </div>
  )
}
