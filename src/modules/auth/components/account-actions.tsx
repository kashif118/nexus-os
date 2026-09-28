'use client'

import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import {
  resendVerificationAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  signOutAction,
  type FormState,
} from '../actions'

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <SubmitButton variant="outline" size="sm" pendingLabel="Signing out…">
        Sign out
      </SubmitButton>
    </form>
  )
}

export function ResendVerificationButton() {
  const [state, formAction] = useActionState<FormState, FormData>(resendVerificationAction, null)

  return (
    <div className="space-y-2">
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <form action={formAction}>
        <SubmitButton variant="outline" size="sm" pendingLabel="Sending…">
          Resend confirmation email
        </SubmitButton>
      </form>
    </div>
  )
}

export function RevokeSessionButton({ sessionId }: { sessionId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(revokeSessionAction, null)

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="sessionId" value={sessionId} />
      <Button type="submit" variant="ghost" size="sm">
        Sign out
      </Button>
      {state && !state.ok ? (
        <span className="text-destructive text-xs">{state.error.message}</span>
      ) : null}
    </form>
  )
}

export function RevokeOtherSessionsButton() {
  const [state, formAction] = useActionState<FormState, FormData>(revokeOtherSessionsAction, null)

  return (
    <div className="space-y-2">
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      <form action={formAction}>
        <SubmitButton variant="outline" size="sm" pendingLabel="Signing out…">
          Sign out all other sessions
        </SubmitButton>
      </form>
    </div>
  )
}
