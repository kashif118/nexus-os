'use client'

import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import {
  addChecklistItemAction,
  addCommentAction,
  addDependencyAction,
  createTaskAction,
  removeDependencyAction,
  toggleChecklistItemAction,
  updateTaskAction,
  type FormState,
} from '../actions'
import { DEPENDENCY_TYPES, TASK_PRIORITIES, TASK_STATUSES } from '../schema'

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')

export interface TaskFormOptions {
  members: Array<{ id: string; name: string }>
  projects: Array<{ id: string; key: string; name: string }>
  labels: Array<{ id: string; name: string; color: string }>
}

function SelectField({
  name,
  label,
  options,
  defaultValue,
  placeholder,
  errors,
}: {
  name: string
  label: string
  options: Array<{ value: string; label: string }>
  defaultValue?: string | undefined
  placeholder?: string
  errors?: string[] | undefined
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <NativeSelect id={name} name={name} defaultValue={defaultValue ?? ''}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      {errors?.length ? <p className="text-destructive text-xs">{errors.join(' ')}</p> : null}
    </div>
  )
}

export function TaskForm({
  orgSlug,
  options,
  task,
  defaultProjectId,
}: {
  orgSlug: string
  options: TaskFormOptions
  defaultProjectId?: string | undefined
  task?: {
    id: string
    title: string
    description: string | null
    projectId: string | null
    assigneeMembershipId: string | null
    status: string
    priority: string
    startDate: Date | null
    dueDate: Date | null
    estimateMinutes: number | null
  }
}) {
  const action = task
    ? updateTaskAction.bind(null, orgSlug, task.id)
    : createTaskAction.bind(null, orgSlug)

  const [state, formAction] = useActionState<FormState, FormData>(action, null)
  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field
        name="title"
        label="Title"
        required
        defaultValue={task?.title}
        errors={fields?.title}
      />

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          rows={5}
          defaultValue={task?.description ?? ''}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="projectId"
          label="Project"
          placeholder="No project"
          defaultValue={task?.projectId ?? defaultProjectId ?? ''}
          options={options.projects.map((project) => ({
            value: project.id,
            label: `${project.key} · ${project.name}`,
          }))}
          errors={fields?.projectId}
        />
        <SelectField
          name="assigneeMembershipId"
          label="Assignee"
          placeholder="Unassigned"
          defaultValue={task?.assigneeMembershipId ?? ''}
          options={options.members.map((member) => ({ value: member.id, label: member.name }))}
          errors={fields?.assigneeMembershipId}
        />
        <SelectField
          name="status"
          label="Status"
          defaultValue={task?.status ?? 'BACKLOG'}
          options={TASK_STATUSES.map((value) => ({ value, label: titleCase(value) }))}
        />
        <SelectField
          name="priority"
          label="Priority"
          defaultValue={task?.priority ?? 'MEDIUM'}
          options={TASK_PRIORITIES.map((value) => ({ value, label: titleCase(value) }))}
        />
        <Field
          name="startDate"
          label="Start"
          type="date"
          defaultValue={task?.startDate?.toISOString().slice(0, 10) ?? ''}
        />
        <Field
          name="dueDate"
          label="Due"
          type="date"
          defaultValue={task?.dueDate?.toISOString().slice(0, 10) ?? ''}
        />
        <Field
          name="estimateMinutes"
          label="Estimate (minutes)"
          type="number"
          min={0}
          defaultValue={task?.estimateMinutes?.toString() ?? ''}
          errors={fields?.estimateMinutes}
        />
      </div>

      <SubmitButton pendingLabel="Saving…">{task ? 'Save changes' : 'Create task'}</SubmitButton>
    </form>
  )
}

/* ------------------------------ dependencies ------------------------------ */

export function DependencyPanel({
  orgSlug,
  taskId,
  dependencies,
  dependents,
  candidates,
  canEdit,
}: {
  orgSlug: string
  taskId: string
  dependencies: Array<{
    id: string
    type: string
    dependsOn: { id: string; number: number; title: string; status: string }
  }>
  dependents: Array<{
    id: string
    task: { id: string; number: number; title: string; status: string }
  }>
  candidates: Array<{ id: string; number: number; title: string }>
  canEdit: boolean
}) {
  const [addState, addAction] = useActionState<FormState, FormData>(
    addDependencyAction.bind(null, orgSlug),
    null,
  )
  const [removeState, removeAction] = useActionState<FormState, FormData>(
    removeDependencyAction.bind(null, orgSlug),
    null,
  )

  const error = [addState, removeState].find((state) => state && !state.ok) as
    Extract<FormState, { ok: false }> | undefined

  return (
    <div className="space-y-4">
      {error ? <Alert variant="destructive">{error.error.message}</Alert> : null}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide uppercase">Blocked by</h3>
        {dependencies.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing is blocking this task.</p>
        ) : (
          <ul className="divide-border divide-y text-sm">
            {dependencies.map((dependency) => {
              const satisfied =
                dependency.dependsOn.status === 'DONE' ||
                dependency.dependsOn.status === 'CANCELLED'

              return (
                <li key={dependency.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate">
                      <span className="text-muted-foreground font-mono text-xs">
                        {dependency.dependsOn.number}
                      </span>{' '}
                      {dependency.dependsOn.title}
                    </p>
                    <p className="text-muted-foreground text-xs">{titleCase(dependency.type)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={satisfied ? 'success' : 'warning'}>
                      {satisfied ? 'Satisfied' : titleCase(dependency.dependsOn.status)}
                    </Badge>
                    {canEdit ? (
                      <form action={removeAction}>
                        <input type="hidden" name="taskId" value={taskId} />
                        <input
                          type="hidden"
                          name="dependsOnTaskId"
                          value={dependency.dependsOn.id}
                        />
                        <Button type="submit" variant="ghost" size="sm">
                          Remove
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {dependents.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wide uppercase">Blocking</h3>
          <ul className="text-sm">
            {dependents.map((dependent) => (
              <li key={dependent.id} className="py-1">
                <span className="text-muted-foreground font-mono text-xs">
                  {dependent.task.number}
                </span>{' '}
                {dependent.task.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canEdit && candidates.length > 0 ? (
        <form action={addAction} className="space-y-2 border-t pt-3">
          <input type="hidden" name="taskId" value={taskId} />
          <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
            <SelectField
              name="dependsOnTaskId"
              label="Add a blocker"
              placeholder="Choose a task…"
              options={candidates.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.number} · ${candidate.title}`,
              }))}
            />
            <SelectField
              name="type"
              label="Type"
              defaultValue="FINISH_START"
              options={DEPENDENCY_TYPES.map((value) => ({ value, label: titleCase(value) }))}
            />
          </div>
          <SubmitButton variant="outline" size="sm" pendingLabel="Adding…">
            Add dependency
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

/* -------------------------------- checklist ------------------------------- */

export function ChecklistPanel({
  orgSlug,
  taskId,
  items,
  canEdit,
}: {
  orgSlug: string
  taskId: string
  items: Array<{ id: string; content: string; done: boolean }>
  canEdit: boolean
}) {
  const [, addAction] = useActionState<FormState, FormData>(
    addChecklistItemAction.bind(null, orgSlug),
    null,
  )
  const [, toggleAction] = useActionState<FormState, FormData>(
    toggleChecklistItemAction.bind(null, orgSlug),
    null,
  )

  const done = items.filter((item) => item.done).length

  return (
    <div className="space-y-3">
      {items.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {done} of {items.length} complete
        </p>
      ) : null}

      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <form action={toggleAction} className="flex items-center gap-2">
              <input type="hidden" name="taskId" value={taskId} />
              <input type="hidden" name="itemId" value={item.id} />
              {/* Submitting the opposite of the current state keeps this a
                  plain form that works without client JavaScript. */}
              {item.done ? null : <input type="hidden" name="done" value="on" />}
              <Checkbox checked={item.done} disabled={!canEdit} aria-hidden="true" tabIndex={-1} />
              <button
                type="submit"
                disabled={!canEdit}
                className={`flex-1 text-left text-sm ${item.done ? 'text-muted-foreground line-through' : ''}`}
              >
                {item.content}
              </button>
            </form>
          </li>
        ))}
      </ul>

      {canEdit ? (
        <form action={addAction} className="flex items-end gap-2">
          <input type="hidden" name="taskId" value={taskId} />
          <Field name="content" label="Add an item" className="flex-1" />
          <SubmitButton variant="outline" size="sm" pendingLabel="Adding…">
            Add
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

/* --------------------------------- comments ------------------------------- */

export function CommentsPanel({
  orgSlug,
  taskId,
  comments,
  canComment,
}: {
  orgSlug: string
  taskId: string
  comments: Array<{
    id: string
    body: string
    createdAt: Date
    author: { user: { name: string } } | null
  }>
  canComment: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    addCommentAction.bind(null, orgSlug),
    null,
  )

  return (
    <div className="space-y-4">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      {comments.length === 0 ? (
        <p className="text-muted-foreground text-sm">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="space-y-1">
              <p className="text-xs font-medium">
                {comment.author?.user.name ?? 'Someone'}{' '}
                <span className="text-muted-foreground font-normal">
                  {comment.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                </span>
              </p>
              <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}

      {canComment ? (
        <form action={formAction} className="space-y-2 border-t pt-3">
          <input type="hidden" name="taskId" value={taskId} />
          <Label htmlFor="body" className="sr-only">
            Comment
          </Label>
          <Textarea
            id="body"
            name="body"
            rows={3}
            placeholder="Write a comment. Use @name to mention someone."
          />
          <SubmitButton variant="outline" size="sm" pendingLabel="Posting…">
            Comment
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}
