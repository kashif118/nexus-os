'use client'

import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'

import { refreshStatusesAction, type FormState } from '../actions'

/**
 * Re-derive invoice statuses from the facts.
 *
 * "Overdue" is a function of the due date and the balance, not a state someone
 * sets. Until this product has a scheduler, this button applies the same sweep
 * a nightly job would; the logic lives in the service either way.
 */
export function RefreshStatusesButton({ orgSlug }: { orgSlug: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(
    refreshStatusesAction.bind(null, orgSlug),
    null,
  )

  return (
    <form action={formAction} className="flex items-center gap-2">
      {state?.ok && state.data.message ? (
        <span className="text-muted-foreground text-xs">{state.data.message}</span>
      ) : null}
      <SubmitButton size="sm" variant="outline" pendingLabel="Checking…">
        Refresh statuses
      </SubmitButton>
    </form>
  )
}
