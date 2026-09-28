'use client'

import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { acceptInvitationAction, type FormState } from '../actions'

/**
 * Redeems an invitation on an explicit submit.
 *
 * Deliberately not done on page load: mail clients and link scanners fetch
 * every URL in a message, and an invitation is single-use.
 */
export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(acceptInvitationAction, null)

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <SubmitButton className="w-full" pendingLabel="Joining…">
        Accept invitation
      </SubmitButton>
    </form>
  )
}
