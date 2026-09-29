'use client'

import { useRouter } from 'next/navigation'
import { useActionState, useEffect } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'

import {
  createWorkflowAction,
  decideApprovalAction,
  deleteWorkflowAction,
  runWorkflowAction,
  setStatusAction,
  type FormState,
} from '../actions'

/** Create a workflow: a name and the event that starts it. */
export function CreateWorkflowForm({
  orgSlug,
  triggers,
}: {
  orgSlug: string
  triggers: Array<{ type: string; label: string; description: string }>
}) {
  const router = useRouter()
  const [state, formAction] = useActionState<FormState, FormData>(
    createWorkflowAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined
  const createdId = state?.ok ? state.data.id : undefined

  useEffect(() => {
    if (createdId) router.push(`/${orgSlug}/workflows/${createdId}`)
  }, [createdId, orgSlug, router])

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <Field name="name" label="Name" required errors={fields?.name} />
      <Field name="description" label="Description" errors={fields?.description} />

      <div className="space-y-1.5">
        <Label htmlFor="triggerType">Runs when</Label>
        <NativeSelect id="triggerType" name="triggerType" defaultValue="">
          <option value="">Choose a trigger…</option>
          {triggers.map((trigger) => (
            <option key={trigger.type} value={trigger.type}>
              {trigger.label}
            </option>
          ))}
        </NativeSelect>
        {fields?.triggerType ? (
          <p className="text-destructive text-xs">{fields.triggerType.join(' ')}</p>
        ) : null}
      </div>

      <SubmitButton size="sm" pendingLabel="Creating…">
        Create workflow
      </SubmitButton>
    </form>
  )
}

/** Pause, activate or delete. */
export function WorkflowStatusControls({
  orgSlug,
  workflowId,
  status,
  canDelete,
}: {
  orgSlug: string
  workflowId: string
  status: string
  canDelete: boolean
}) {
  const router = useRouter()
  const [statusState, changeStatus] = useActionState<FormState, FormData>(
    setStatusAction.bind(null, orgSlug),
    null,
  )
  const [deleteState, remove] = useActionState<FormState, FormData>(
    deleteWorkflowAction.bind(null, orgSlug),
    null,
  )

  useEffect(() => {
    if (deleteState?.ok) router.replace(`/${orgSlug}/workflows`)
  }, [deleteState, orgSlug, router])

  const failure = [statusState, deleteState].find((entry) => entry && !entry.ok)

  return (
    <div className="space-y-2">
      {failure && !failure.ok ? <Alert variant="destructive">{failure.error.message}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <form action={changeStatus}>
          <input type="hidden" name="id" value={workflowId} />
          <input type="hidden" name="status" value={status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'} />
          <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
            {status === 'ACTIVE' ? 'Pause' : 'Activate'}
          </SubmitButton>
        </form>

        {canDelete ? (
          <form action={remove}>
            <input type="hidden" name="id" value={workflowId} />
            <SubmitButton size="sm" variant="ghost" pendingLabel="Deleting…">
              Delete
            </SubmitButton>
          </form>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Run a workflow by hand.
 *
 * A test run is the default and performs nothing: actions describe what they
 * would do. Running for real is a separate checkbox, because "try it" should
 * never be the destructive option.
 */
export function RunWorkflowForm({
  orgSlug,
  workflowId,
  sampleFields,
}: {
  orgSlug: string
  workflowId: string
  sampleFields: string[]
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    runWorkflowAction.bind(null, orgSlug),
    null,
  )

  const sample = JSON.stringify(
    Object.fromEntries(sampleFields.map((field) => [field, ''])),
    null,
    2,
  )

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      <input type="hidden" name="workflowId" value={workflowId} />

      <div className="space-y-1.5">
        <Label htmlFor="payload">Sample event payload</Label>
        <textarea
          id="payload"
          name="payload"
          rows={6}
          defaultValue={sample}
          spellCheck={false}
          className="border-input bg-background w-full rounded-md border p-2 font-mono text-xs"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="live" value="on" className="size-4" />
        Run for real (actions will take effect)
      </label>

      <SubmitButton size="sm" variant="outline" pendingLabel="Running…">
        Run
      </SubmitButton>
    </form>
  )
}

/** Decide one approval step. */
export function ApprovalControls({ orgSlug, stepId }: { orgSlug: string; stepId: string }) {
  const [approveState, approve] = useActionState<FormState, FormData>(
    decideApprovalAction.bind(null, orgSlug, true),
    null,
  )
  const [rejectState, reject] = useActionState<FormState, FormData>(
    decideApprovalAction.bind(null, orgSlug, false),
    null,
  )

  const failure = [approveState, rejectState].find((entry) => entry && !entry.ok)

  return (
    <div className="space-y-2">
      {failure && !failure.ok ? <Alert variant="destructive">{failure.error.message}</Alert> : null}

      <div className="flex gap-2">
        <form action={approve}>
          <input type="hidden" name="stepId" value={stepId} />
          <SubmitButton size="sm" pendingLabel="Approving…">
            Approve
          </SubmitButton>
        </form>
        <form action={reject}>
          <input type="hidden" name="stepId" value={stepId} />
          <SubmitButton size="sm" variant="destructive" pendingLabel="Rejecting…">
            Reject
          </SubmitButton>
        </form>
      </div>
    </div>
  )
}
