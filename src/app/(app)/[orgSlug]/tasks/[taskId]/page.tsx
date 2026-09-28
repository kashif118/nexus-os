import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import {
  ChecklistPanel,
  CommentsPanel,
  DependencyPanel,
  TaskForm,
} from '@/modules/tasks/components/task-detail'
import { getTask, getTaskFormOptions, listTasks } from '@/modules/tasks/queries'
import { TASK_SORT_FIELDS } from '@/modules/tasks/schema'

export const metadata: Metadata = { title: 'Task' }

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; taskId: string }>
}) {
  const { orgSlug, taskId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let task: Awaited<ReturnType<typeof getTask>>
  try {
    task = await getTask(ctx, taskId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const [options, candidatePage] = await Promise.all([
    getTaskFormOptions(ctx),
    listTasks(
      ctx,
      parseListParams(
        { pageSize: '100' },
        { sortableFields: TASK_SORT_FIELDS, defaultSort: 'number' },
      ),
    ),
  ])

  // A task cannot depend on itself, and offering a task it already blocks would
  // only produce a cycle error on submit.
  const existingBlockers = new Set(task.dependencies.map((entry) => entry.dependsOn.id))
  const candidates = candidatePage.items
    .filter((entry) => entry.id !== task.id && !existingBlockers.has(entry.id))
    .map((entry) => ({ id: entry.id, number: entry.number, title: entry.title }))

  const canEdit =
    ctx.can('task.update.any') ||
    (ctx.can('task.update.own') &&
      (task.assigneeMembershipId === ctx.membershipId || task.parentTaskId === null))

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title={task.title}
        description={task.project ? `${task.project.key} · ${task.project.name}` : 'No project'}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">#{task.number}</Badge>
            <Badge variant={task.status === 'DONE' ? 'success' : 'neutral'}>
              {titleCase(task.status)}
            </Badge>
          </div>
        }
      />

      {task.blockers.length > 0 && task.status !== 'DONE' ? (
        <Alert variant="warning">
          This task cannot start yet — it is blocked by{' '}
          {task.blockers.map((blocker) => blocker.title).join(', ')}.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {canEdit ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <TaskForm orgSlug={orgSlug} options={options} task={task} />
              </CardContent>
            </Card>
          ) : task.description ? (
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{task.description}</p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Comments</CardTitle>
            </CardHeader>
            <CardContent>
              <CommentsPanel
                orgSlug={orgSlug}
                taskId={task.id}
                comments={task.comments}
                canComment={ctx.can('task.comment')}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Dependencies</CardTitle>
            </CardHeader>
            <CardContent>
              <DependencyPanel
                orgSlug={orgSlug}
                taskId={task.id}
                dependencies={task.dependencies}
                dependents={task.dependents}
                candidates={candidates}
                canEdit={canEdit}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Checklist</CardTitle>
            </CardHeader>
            <CardContent>
              <ChecklistPanel
                orgSlug={orgSlug}
                taskId={task.id}
                items={task.checklist}
                canEdit={canEdit}
              />
            </CardContent>
          </Card>

          {task.subtasks.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Subtasks ({task.subtasks.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-border divide-y text-sm">
                  {task.subtasks.map((subtask) => (
                    <li key={subtask.id} className="flex items-center justify-between gap-2 py-2">
                      <Link
                        href={`/${orgSlug}/tasks/${subtask.id}`}
                        className="truncate hover:underline"
                      >
                        {subtask.title}
                      </Link>
                      <Badge variant={subtask.status === 'DONE' ? 'success' : 'neutral'}>
                        {titleCase(subtask.status)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
