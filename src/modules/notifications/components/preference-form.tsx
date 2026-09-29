'use client'

import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { updatePreferenceAction, type FormState } from '../actions'

export interface PreferenceRow {
  eventType: string
  label: string
  group: string
  inApp: boolean
  email: boolean
  digest: boolean
  isDefault: boolean
}

/**
 * One row per event type.
 *
 * Each row is its own form so a change saves on its own without a global Save
 * button that silently discards the rows you did not touch. A checkbox that is
 * unchecked sends nothing, which is exactly what the schema expects — an absent
 * field parses as false.
 */
export function PreferenceRowForm({
  orgSlug,
  preference,
}: {
  orgSlug: string
  preference: PreferenceRow
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    updatePreferenceAction.bind(null, orgSlug),
    null,
  )

  return (
    <form action={formAction} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <input type="hidden" name="eventType" value={preference.eventType} />

      <div className="min-w-0">
        <p className="text-sm">{preference.label}</p>
        {state && !state.ok ? (
          <Alert variant="destructive" className="mt-1">
            {state.error.message}
          </Alert>
        ) : null}
        {state?.ok ? <p className="text-muted-foreground text-xs">Saved.</p> : null}
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            name="inApp"
            value="on"
            defaultChecked={preference.inApp}
            className="size-4"
          />
          In app
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            name="email"
            value="on"
            defaultChecked={preference.email}
            className="size-4"
          />
          Email
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            name="digest"
            value="on"
            defaultChecked={preference.digest}
            className="size-4"
          />
          Digest
        </label>

        <SubmitButton size="sm" variant="ghost" pendingLabel="Saving…">
          Save
        </SubmitButton>
      </div>
    </form>
  )
}
