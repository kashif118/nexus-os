import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { KanbanBoard } from '@/modules/tasks/components/kanban-board'
import { getBoard } from '@/modules/tasks/queries'

export const metadata: Metadata = { title: 'Tasks' }

export default async function TasksBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ project?: string; mine?: string }>
}) {
  const { orgSlug } = await params
  const { project, mine } = await searchParams
  const ctx = await requireCtxPage(orgSlug)

  let board: Awaited<ReturnType<typeof getBoard>>
  try {
    board = await getBoard(ctx, { projectId: project, mine: mine === '1' })
  } catch (error) {
    if (isAppError(error) && error.code === 'FORBIDDEN') notFound()
    throw error
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <PageHeader
        title="Tasks"
        description="Drag a card between columns, or use the selector on each card."
        actions={
          ctx.can('task.create') ? (
            <Link href={`/${orgSlug}/tasks/new`} className={buttonVariants({ size: 'sm' })}>
              New task
            </Link>
          ) : null
        }
      />

      <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter tasks">
        <Link
          href={`/${orgSlug}/tasks`}
          className={`rounded-md px-2 py-1 ${!mine ? 'bg-accent' : 'hover:bg-accent/60'}`}
        >
          All tasks
        </Link>
        <Link
          href={`/${orgSlug}/tasks?mine=1`}
          className={`rounded-md px-2 py-1 ${mine === '1' ? 'bg-accent' : 'hover:bg-accent/60'}`}
        >
          My work
        </Link>
      </nav>

      <KanbanBoard
        orgSlug={orgSlug}
        tasks={board.tasks}
        canMove={ctx.canAny(['task.update.any', 'task.update.own'])}
      />
    </div>
  )
}
