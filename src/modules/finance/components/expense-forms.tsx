'use client'

import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import {
  createBudgetAction,
  createCategoryAction,
  createExpenseAction,
  decideExpenseAction,
  submitExpenseAction,
  type FormState,
} from '../actions'
import { BUDGET_SCOPES } from '../schema'

/** File an expense claim. */
export function ExpenseForm({
  orgSlug,
  currency,
  categories,
  projects,
}: {
  orgSlug: string
  currency: string
  categories: Array<{ id: string; name: string }>
  projects: Array<{ id: string; key: string; name: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createExpenseAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="vendor" label="Vendor" errors={fields?.vendor} />
        <Field
          name="incurredOn"
          label="Date"
          type="date"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
          errors={fields?.incurredOn}
        />
        <Field
          name="amount"
          label={`Amount (${currency})`}
          inputMode="decimal"
          required
          errors={fields?.amount}
        />
        <Field name="tax" label={`Tax (${currency})`} inputMode="decimal" errors={fields?.tax} />
        <div className="space-y-1.5">
          <Label htmlFor="categoryId">Category</Label>
          <NativeSelect id="categoryId" name="categoryId" defaultValue="">
            <option value="">Uncategorised</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="projectId">Project</Label>
          <NativeSelect id="projectId" name="projectId" defaultValue="">
            <option value="">None</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.key} · {project.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" rows={2} />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="submit" value="on" defaultChecked className="size-4" />
        Submit for approval now
      </label>

      <SubmitButton size="sm" pendingLabel="Saving…">
        Add expense
      </SubmitButton>
    </form>
  )
}

/**
 * Approve or reject a submitted claim.
 *
 * Rendered only when the server has already established that the viewer holds
 * the permission AND is not the claimant; the action refuses self-approval
 * regardless of what is rendered.
 */
export function ExpenseDecisionControls({
  orgSlug,
  expenseId,
  canApprove,
  canReject,
}: {
  orgSlug: string
  expenseId: string
  canApprove: boolean
  canReject: boolean
}) {
  const [approveState, approveAction] = useActionState<FormState, FormData>(
    decideExpenseAction.bind(null, orgSlug, true),
    null,
  )
  const [rejectState, rejectAction] = useActionState<FormState, FormData>(
    decideExpenseAction.bind(null, orgSlug, false),
    null,
  )

  const failure = [approveState, rejectState].find((state) => state && !state.ok)

  return (
    <div className="space-y-2">
      {failure && !failure.ok ? <Alert variant="destructive">{failure.error.message}</Alert> : null}

      <div className="flex flex-wrap items-end gap-2">
        {canApprove ? (
          <form action={approveAction}>
            <input type="hidden" name="expenseId" value={expenseId} />
            <SubmitButton size="sm" pendingLabel="Approving…">
              Approve
            </SubmitButton>
          </form>
        ) : null}

        {canReject ? (
          <form action={rejectAction} className="flex items-end gap-2">
            <input type="hidden" name="expenseId" value={expenseId} />
            <Field name="note" label="Reason" className="w-48" />
            <SubmitButton size="sm" variant="destructive" pendingLabel="Rejecting…">
              Reject
            </SubmitButton>
          </form>
        ) : null}
      </div>
    </div>
  )
}

/** Send a draft claim for approval. */
export function SubmitExpenseButton({
  orgSlug,
  expenseId,
}: {
  orgSlug: string
  expenseId: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    submitExpenseAction.bind(null, orgSlug),
    null,
  )

  return (
    <form action={formAction} className="space-y-2">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="id" value={expenseId} />
      <SubmitButton size="sm" variant="outline" pendingLabel="Submitting…">
        Submit for approval
      </SubmitButton>
    </form>
  )
}

/** Add an expense category. */
export function CategoryForm({ orgSlug }: { orgSlug: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createCategoryAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined

  return (
    <form action={formAction} className="flex items-end gap-2" noValidate>
      <Field name="name" label="New category" className="flex-1" errors={fields?.name} />
      <SubmitButton size="sm" variant="outline" pendingLabel="Adding…">
        Add
      </SubmitButton>
    </form>
  )
}

/** Set a budget for a period and scope. */
export function BudgetForm({
  orgSlug,
  currency,
  projects,
  categories,
}: {
  orgSlug: string
  currency: string
  projects: Array<{ id: string; key: string; name: string }>
  categories: Array<{ id: string; name: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createBudgetAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined

  const today = new Date()
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="scopeType">Scope</Label>
          <NativeSelect id="scopeType" name="scopeType" defaultValue="ORGANIZATION">
            {BUDGET_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope.charAt(0) + scope.slice(1).toLowerCase()}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="scopeId">Applies to</Label>
          <NativeSelect id="scopeId" name="scopeId" defaultValue="">
            <option value="">Whole organization</option>
            <optgroup label="Projects">
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.key} · {project.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Categories">
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </optgroup>
          </NativeSelect>
        </div>
        <Field
          name="periodStart"
          label="Period start"
          type="date"
          required
          defaultValue={start.toISOString().slice(0, 10)}
          errors={fields?.periodStart}
        />
        <Field
          name="periodEnd"
          label="Period end"
          type="date"
          required
          defaultValue={end.toISOString().slice(0, 10)}
          errors={fields?.periodEnd}
        />
        <Field
          name="amount"
          label={`Amount (${currency})`}
          inputMode="decimal"
          required
          errors={fields?.amount}
        />
      </div>

      <SubmitButton size="sm" pendingLabel="Saving…">
        Create budget
      </SubmitButton>
    </form>
  )
}
