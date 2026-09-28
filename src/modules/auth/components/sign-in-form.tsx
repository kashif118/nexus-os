'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { signInAction, type FormState } from '../actions'

/**
 * Sign-in form.
 *
 * A plain `<form action={...}>` posting to a Server Action: it submits and
 * validates without client-side JavaScript, and `useActionState` only adds the
 * error display and pending state on top.
 */
export function SignInForm({ next }: { next?: string | undefined }) {
  const [state, formAction] = useActionState<FormState, FormData>(signInAction, null)
  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        errors={fields?.email}
      />

      <div className="space-y-1.5">
        <Field
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          errors={fields?.password}
        />
        <Link
          href="/forgot-password"
          className="text-muted-foreground hover:text-foreground inline-block text-xs underline-offset-4 hover:underline"
        >
          Forgot your password?
        </Link>
      </div>

      <SubmitButton className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  )
}
