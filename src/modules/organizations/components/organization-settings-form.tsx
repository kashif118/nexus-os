'use client'

import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { updateOrganizationAction, type FormState } from '../actions'

export interface OrganizationFormValues {
  name: string
  description: string | null
  industry: string | null
  timezone: string
  currency: string
  country: string | null
}

/**
 * Organization settings.
 *
 * `readOnly` only hides the controls. The service re-checks ownership on every
 * submit, so disabling inputs is a courtesy, never the control
 * (docs/PLATFORM.md §I.5).
 */
export function OrganizationSettingsForm({
  orgSlug,
  values,
  readOnly,
}: {
  orgSlug: string
  values: OrganizationFormValues
  readOnly: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    updateOrganizationAction.bind(null, orgSlug),
    null,
  )

  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field
        name="name"
        label="Name"
        defaultValue={values.name}
        required
        disabled={readOnly}
        errors={fields?.name}
      />
      <Field
        name="description"
        label="Description"
        defaultValue={values.description ?? ''}
        disabled={readOnly}
        errors={fields?.description}
      />
      <Field
        name="industry"
        label="Industry"
        defaultValue={values.industry ?? ''}
        disabled={readOnly}
        errors={fields?.industry}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="timezone"
          label="Time zone"
          defaultValue={values.timezone}
          required
          disabled={readOnly}
          errors={fields?.timezone}
          hint="IANA name, for example Europe/London"
        />
        <Field
          name="currency"
          label="Currency"
          defaultValue={values.currency}
          required
          disabled={readOnly}
          errors={fields?.currency}
          hint="ISO-4217 code, for example USD"
        />
      </div>

      <Field
        name="country"
        label="Country"
        defaultValue={values.country ?? ''}
        disabled={readOnly}
        errors={fields?.country}
      />

      {readOnly ? (
        <Alert>Only the organization owner can change these settings.</Alert>
      ) : (
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      )}
    </form>
  )
}
