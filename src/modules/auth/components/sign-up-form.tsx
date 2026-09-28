'use client'

import { useActionState, useState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

import { signUpAction, type FormState } from '../actions'
import { assessPasswordStrength, PASSWORD_MIN_LENGTH } from '../schema'

/**
 * Sign-up form.
 *
 * The strength meter is advisory only — the enforced policy is the Zod schema,
 * re-parsed server-side by the action.
 */
export function SignUpForm() {
  const [state, formAction] = useActionState<FormState, FormData>(signUpAction, null)
  const [password, setPassword] = useState('')
  const strength = assessPasswordStrength(password)

  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field name="name" label="Name" autoComplete="name" required errors={fields?.name} />
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        errors={fields?.email}
      />

      <div className="space-y-2">
        <Field
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          errors={fields?.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. Length matters more than symbols.`}
        />

        {password.length > 0 ? (
          <div className="flex items-center gap-2">
            <div className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  strength.score <= 1 && 'bg-destructive',
                  strength.score === 2 && 'bg-warning',
                  strength.score === 3 && 'bg-info',
                  strength.score >= 4 && 'bg-success',
                )}
                style={{ width: `${(strength.score / 4) * 100}%` }}
              />
            </div>
            <span className="text-muted-foreground w-16 text-right text-xs">{strength.label}</span>
          </div>
        ) : null}
      </div>

      <SubmitButton className="w-full" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  )
}
