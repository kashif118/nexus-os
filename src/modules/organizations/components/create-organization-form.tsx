'use client'

import { useActionState, useState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { createOrganizationAction, type FormState } from '../actions'
import { slugify } from '../schema'

const COMMON_TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Singapore',
  'Australia/Sydney',
]
const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'PKR', 'INR', 'CAD', 'AUD', 'SGD']

export function CreateOrganizationForm() {
  const [state, formAction] = useActionState<FormState, FormData>(createOrganizationAction, null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)

  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  // The slug follows the name until the user edits it themselves.
  const effectiveSlug = slugTouched ? slug : slugify(name)

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field
        name="name"
        label="Organization name"
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
        errors={fields?.name}
      />

      <Field
        name="slug"
        label="Web address"
        required
        value={effectiveSlug}
        onChange={(event) => {
          setSlugTouched(true)
          setSlug(event.target.value)
        }}
        errors={fields?.slug}
        hint={`Your workspace will live at /${effectiveSlug || 'your-org'}`}
      />

      <Field name="industry" label="Industry (optional)" errors={fields?.industry} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="timezone" className="text-sm leading-none font-medium">
            Time zone
          </label>
          <select
            id="timezone"
            name="timezone"
            defaultValue="UTC"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            {COMMON_TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="currency" className="text-sm leading-none font-medium">
            Currency
          </label>
          <select
            id="currency"
            name="currency"
            defaultValue="USD"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            {COMMON_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Field name="country" label="Country (optional)" errors={fields?.country} />

      <SubmitButton className="w-full" pendingLabel="Creating…">
        Create organization
      </SubmitButton>
    </form>
  )
}
