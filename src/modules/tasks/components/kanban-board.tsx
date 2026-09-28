'use client'

import Link from 'next/link'
import { useOptimistic, useRef, useState, useTransition } from 'react'

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import { moveTaskAction } from '../actions'
import { BOARD_COLUMNS } from '../schema'

/**
 * The Kanban board.
 *
 * Drag and drop uses the native HTML5 API. A drag library would add weight for
 * behaviour the platform already provides, and the accessible path — a keyboard
 * status selector on every card — has to exist regardless, because dragging is
 * unusable with a keyboard, on touch, or with a screen reader.
 *
 * Moves are optimistic and reconciled by the server. A move REFUSED by a
 * dependency is a legitimate answer rather than an error: the optimistic state
 * is rolled back and the reason is shown, naming the blocking task.
 */

export interface BoardTask {
  id: string
  number: number
  title: string
  status: string
  priority: string
  dueDate: Date | null
  boardOrder: number
  project: { id: string; key: string } | null
  assignee: { id: string; user: { name: string } } | null
  labels: Array<{ label: { id: string; name: string; color: string } }>
  _count: { dependencies: number; checklist: number }
}

const COLUMN_LABEL: Record<string, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  DONE: 'Done',
}

const PRIORITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'destructive'> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  URGENT: 'destructive',
}

export function KanbanBoard({
  orgSlug,
  tasks,
  canMove,
}: {
  orgSlug: string
  tasks: BoardTask[]
  canMove: boolean
}) {
  const [, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<string | null>(null)

  // Tracks the card a drop should land above, so a drag can reorder within a
  // column rather than only changing columns.
  const dropTarget = useRef<string | null>(null)

  const [optimisticTasks, applyMove] = useOptimistic(
    tasks,
    (current, move: { taskId: string; status: string }) =>
      current.map((task) => (task.id === move.taskId ? { ...task, status: move.status } : task)),
  )

  function move(taskId: string, status: string, beforeId?: string, afterId?: string) {
    const task = optimisticTasks.find((entry) => entry.id === taskId)
    if (!task) return
    if (task.status === status && !beforeId && !afterId) return

    setError(null)
    startTransition(async () => {
      applyMove({ taskId, status })

      const formData = new FormData()
      formData.set('taskId', taskId)
      formData.set('status', status)
      if (beforeId) formData.set('beforeId', beforeId)
      if (afterId) formData.set('afterId', afterId)

      const result = await moveTaskAction(orgSlug, null, formData)
      // A dependency block returns CONFLICT with the blockers named.
      if (result && !result.ok) setError(result.error.message)
    })
  }

  return (
    <div className="space-y-3">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div
        className="grid grid-flow-col gap-3 overflow-x-auto pb-2"
        style={{ gridAutoColumns: '17rem' }}
      >
        {BOARD_COLUMNS.map((column) => {
          const columnTasks = optimisticTasks
            .filter((task) => task.status === column)
            .sort((a, b) => a.boardOrder - b.boardOrder)

          return (
            <section
              key={column}
              aria-label={COLUMN_LABEL[column]}
              onDragOver={(event) => {
                if (!canMove || !dragging) return
                event.preventDefault()
                setOverColumn(column)
              }}
              onDragLeave={() => setOverColumn((current) => (current === column ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                setOverColumn(null)
                if (canMove && dragging) {
                  const afterId = dropTarget.current ?? undefined
                  const index = columnTasks.findIndex((task) => task.id === afterId)
                  const beforeId = index > 0 ? columnTasks[index - 1]?.id : undefined
                  move(dragging, column, beforeId, afterId)
                }
                dropTarget.current = null
                setDragging(null)
              }}
              className={cn(
                'bg-muted/40 flex min-h-64 flex-col rounded-lg border p-2 transition-colors',
                overColumn === column && 'border-primary bg-accent/50',
              )}
            >
              <header className="flex items-baseline justify-between gap-2 px-1 pb-2">
                <h3 className="text-sm font-medium">{COLUMN_LABEL[column]}</h3>
                <span className="text-muted-foreground tabular text-xs">{columnTasks.length}</span>
              </header>

              <ul className="flex-1 space-y-2">
                {columnTasks.map((task) => {
                  const overdue =
                    task.dueDate !== null && task.status !== 'DONE' && task.dueDate < new Date()

                  return (
                    <li
                      key={task.id}
                      onDragOver={() => {
                        dropTarget.current = task.id
                      }}
                    >
                      <article
                        draggable={canMove}
                        onDragStart={() => setDragging(task.id)}
                        onDragEnd={() => {
                          setDragging(null)
                          setOverColumn(null)
                          dropTarget.current = null
                        }}
                        className={cn(
                          'bg-card space-y-2 rounded-md border p-2.5 shadow-[var(--shadow-sm)]',
                          canMove && 'cursor-grab active:cursor-grabbing',
                          dragging === task.id && 'opacity-50',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <Link
                            href={`/${orgSlug}/tasks/${task.id}`}
                            className="text-sm font-medium hover:underline"
                          >
                            {task.title}
                          </Link>
                          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                            {task.project?.key ? `${task.project.key}-` : ''}
                            {task.number}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={PRIORITY_TONE[task.priority] ?? 'neutral'}>
                            {task.priority.charAt(0) + task.priority.slice(1).toLowerCase()}
                          </Badge>
                          {task._count.dependencies > 0 ? (
                            <Badge variant="outline">
                              {task._count.dependencies} blocker
                              {task._count.dependencies === 1 ? '' : 's'}
                            </Badge>
                          ) : null}
                          {task.labels.map(({ label }) => (
                            <Badge
                              key={label.id}
                              variant={
                                (label.color as
                                  'neutral' | 'info' | 'success' | 'warning' | 'destructive') ??
                                'neutral'
                              }
                            >
                              {label.name}
                            </Badge>
                          ))}
                        </div>

                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground truncate text-xs">
                            {task.assignee?.user.name ?? 'Unassigned'}
                          </span>
                          {task.dueDate ? (
                            <span className={cn('text-xs', overdue && 'text-destructive')}>
                              {task.dueDate.toISOString().slice(0, 10)}
                            </span>
                          ) : null}
                        </div>

                        {canMove ? (
                          <label className="block">
                            <span className="sr-only">Move {task.title} to another column</span>
                            <select
                              value={task.status}
                              onChange={(event) => move(task.id, event.target.value)}
                              className="border-input bg-background h-7 w-full rounded-md border px-1.5 text-xs"
                            >
                              {BOARD_COLUMNS.map((option) => (
                                <option key={option} value={option}>
                                  {COLUMN_LABEL[option]}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </article>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
