'use client'

import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { resetPasswordAction, type FormState } from '../actions'
import { PASSWORD_MIN_LENGTH } from '../schema'

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(resetPasswordAction, null)

  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}
      <Field
        name="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        errors={fields?.password}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      />
      <SubmitButton className="w-full" pendingLabel="Saving…">
        Set new password
      </SubmitButton>
    </form>
  )
}
