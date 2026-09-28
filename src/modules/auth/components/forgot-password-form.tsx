'use client'

import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { requestPasswordResetAction, type FormState } from '../actions'

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState<FormState, FormData>(requestPasswordResetAction, null)

  if (state?.ok) {
    return <Alert variant="success">{state.data.message}</Alert>
  }

  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        errors={fields?.email}
      />
      <SubmitButton className="w-full" pendingLabel="Sending…">
        Send reset link
      </SubmitButton>
    </form>
  )
}
