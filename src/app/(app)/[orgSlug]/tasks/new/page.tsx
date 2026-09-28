import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { TaskForm } from '@/modules/tasks/components/task-detail'
import { getTaskFormOptions } from '@/modules/tasks/queries'

export const metadata: Metadata = { title: 'New task' }

export default async function NewTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ project?: string }>
}) {
  const { orgSlug } = await params
  const { project } = await searchParams
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('task.create')) notFound()

  const options = await getTaskFormOptions(ctx)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <PageHeader title="New task" />
      <Card>
        <CardContent className="pt-5">
          <TaskForm orgSlug={orgSlug} options={options} defaultProjectId={project} />
        </CardContent>
      </Card>
    </div>
  )
}
