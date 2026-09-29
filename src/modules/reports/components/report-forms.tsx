'use client'

import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { useCreatedRedirect } from '@/components/forms/use-created-redirect'
import { Alert } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'

import { createReportAction, deleteReportAction, type FormState } from '../actions'

export interface TemplateSummary {
  key: string
  name: string
  description: string
  fields: Array<{
    name: string
    label: string
    type: string
    options?: ReadonlyArray<{ value: string; label: string }>
  }>
}

/**
 * Save a report.
 *
 * The parameter fields are generated from the template's own descriptors, so a
 * template that gains an option gets a form control without this file changing.
 */
export function CreateReportForm({
  orgSlug,
  templates,
  canSchedule,
}: {
  orgSlug: string
  templates: TemplateSummary[]
  canSchedule: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createReportAction.bind(null, orgSlug),
    null,
  )
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? '')

  const fields = state && !state.ok ? state.error.fields : undefined
  useCreatedRedirect(state, `/${orgSlug}/reports`)

  const selected = templates.find((template) => template.key === templateKey)

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="template">Report</Label>
        <NativeSelect
          id="template"
          name="template"
          value={templateKey}
          onChange={(event) => setTemplateKey(event.target.value)}
        >
          {templates.map((template) => (
            <option key={template.key} value={template.key}>
              {template.name}
            </option>
          ))}
        </NativeSelect>
        {selected ? <p className="text-muted-foreground text-xs">{selected.description}</p> : null}
      </div>

      <Field name="name" label="Name it" required errors={fields?.name} />

      {selected?.fields.map((field) =>
        field.type === 'period' ? (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={field.name}>{field.label}</Label>
            <NativeSelect id={field.name} name={field.name} defaultValue="30d">
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <Field key={field.name} name={field.name} label={field.label} />
        ),
      )}

      {canSchedule ? (
        <div className="space-y-1.5">
          <Label htmlFor="schedule">Run it automatically</Label>
          <NativeSelect id="schedule" name="schedule" defaultValue="">
            <option value="">Only when I open it</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </NativeSelect>
          <p className="text-muted-foreground text-xs">
            A scheduled run is generated with your permissions. If you lose access to something it
            covers, the report stops rather than sending figures you are no longer entitled to.
          </p>
        </div>
      ) : null}

      <SubmitButton size="sm" pendingLabel="Saving…">
        Save report
      </SubmitButton>
    </form>
  )
}

/** Delete a saved report. */
export function DeleteReportButton({ orgSlug, reportId }: { orgSlug: string; reportId: string }) {
  const router = useRouter()
  const [state, formAction] = useActionState<FormState, FormData>(
    deleteReportAction.bind(null, orgSlug),
    null,
  )

  useEffect(() => {
    if (state?.ok) router.replace(`/${orgSlug}/reports`)
  }, [state, orgSlug, router])

  return (
    <form action={formAction}>
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="id" value={reportId} />
      <SubmitButton size="sm" variant="ghost" pendingLabel="Deleting…">
        Delete
      </SubmitButton>
    </form>
  )
}

/**
 * Print, which is also how a PDF is produced.
 *
 * The browser's own print engine renders better output than a bundled PDF
 * library would, handles pagination properly and needs no dependency. The
 * button says what it does rather than promising a server-generated file.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
    >
      Print or save as PDF
    </button>
  )
}
