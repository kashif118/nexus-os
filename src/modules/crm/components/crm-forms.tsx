'use client'

import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import {
  createCompanyAction,
  createContactAction,
  createDealAction,
  createLeadAction,
  logActivityAction,
  updateCompanyAction,
  updateContactAction,
  updateDealAction,
  updateLeadAction,
  type FormState,
} from '../actions'
import { ACTIVITY_TYPES, LEAD_SOURCES, LEAD_STATUSES } from '../schema'

/**
 * CRM forms.
 *
 * All of them post to Server Actions and re-render field errors returned by the
 * server. Client-side validation is a convenience; the schema is re-parsed on
 * the server every time.
 */

export interface PickerOptions {
  companies: Array<{ id: string; name: string }>
  contacts: Array<{ id: string; firstName: string; lastName: string }>
  members: Array<{ id: string; name: string }>
}

function useFormFields(state: FormState) {
  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null
  return { fields, formError, success: state?.ok ? state.data.message : null }
}

function SelectField({
  name,
  label,
  options,
  defaultValue,
  placeholder = 'None',
  errors,
}: {
  name: string
  label: string
  options: Array<{ value: string; label: string }>
  defaultValue?: string | undefined
  placeholder?: string
  errors?: string[] | undefined
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <NativeSelect
        id={name}
        name={name}
        defaultValue={defaultValue ?? ''}
        aria-invalid={Boolean(errors?.length)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      {errors?.length ? <p className="text-destructive text-xs">{errors.join(' ')}</p> : null}
    </div>
  )
}

/* -------------------------------- companies ------------------------------- */

export function CompanyForm({
  orgSlug,
  options,
  company,
}: {
  orgSlug: string
  options: PickerOptions
  company?: {
    id: string
    name: string
    domain: string | null
    industry: string | null
    size: string | null
    website: string | null
    phone: string | null
    notes: string | null
    ownerMembershipId: string | null
  }
}) {
  const action = company
    ? updateCompanyAction.bind(null, orgSlug, company.id)
    : createCompanyAction.bind(null, orgSlug)

  const [state, formAction] = useActionState<FormState, FormData>(action, null)
  const { fields, formError, success } = useFormFields(state)

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {success ? <Alert variant="success">{success}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field
        name="name"
        label="Company name"
        required
        defaultValue={company?.name}
        errors={fields?.name}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="domain"
          label="Domain"
          defaultValue={company?.domain ?? ''}
          errors={fields?.domain}
        />
        <Field
          name="industry"
          label="Industry"
          defaultValue={company?.industry ?? ''}
          errors={fields?.industry}
        />
        <Field
          name="website"
          label="Website"
          defaultValue={company?.website ?? ''}
          errors={fields?.website}
        />
        <Field
          name="phone"
          label="Phone"
          defaultValue={company?.phone ?? ''}
          errors={fields?.phone}
        />
        <Field name="size" label="Size" defaultValue={company?.size ?? ''} errors={fields?.size} />
        <SelectField
          name="ownerMembershipId"
          label="Owner"
          defaultValue={company?.ownerMembershipId ?? ''}
          placeholder="Unassigned"
          options={options.members.map((member) => ({ value: member.id, label: member.name }))}
          errors={fields?.ownerMembershipId}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={company?.notes ?? ''} />
      </div>

      <SubmitButton pendingLabel="Saving…">
        {company ? 'Save changes' : 'Create company'}
      </SubmitButton>
    </form>
  )
}

/* -------------------------------- contacts -------------------------------- */

export function ContactForm({
  orgSlug,
  options,
  contact,
}: {
  orgSlug: string
  options: PickerOptions
  contact?: {
    id: string
    firstName: string
    lastName: string
    email: string | null
    phone: string | null
    position: string | null
    notes: string | null
    companyId: string | null
    ownerMembershipId: string | null
  }
}) {
  const action = contact
    ? updateContactAction.bind(null, orgSlug, contact.id)
    : createContactAction.bind(null, orgSlug)

  const [state, formAction] = useActionState<FormState, FormData>(action, null)
  const { fields, formError, success } = useFormFields(state)

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {success ? <Alert variant="success">{success}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="firstName"
          label="First name"
          required
          defaultValue={contact?.firstName}
          errors={fields?.firstName}
        />
        <Field
          name="lastName"
          label="Last name"
          required
          defaultValue={contact?.lastName}
          errors={fields?.lastName}
        />
        <Field
          name="email"
          label="Email"
          type="email"
          defaultValue={contact?.email ?? ''}
          errors={fields?.email}
        />
        <Field
          name="phone"
          label="Phone"
          defaultValue={contact?.phone ?? ''}
          errors={fields?.phone}
        />
        <Field
          name="position"
          label="Position"
          defaultValue={contact?.position ?? ''}
          errors={fields?.position}
        />
        <SelectField
          name="companyId"
          label="Company"
          defaultValue={contact?.companyId ?? ''}
          options={options.companies.map((company) => ({ value: company.id, label: company.name }))}
          errors={fields?.companyId}
        />
      </div>

      <SelectField
        name="ownerMembershipId"
        label="Owner"
        defaultValue={contact?.ownerMembershipId ?? ''}
        placeholder="Unassigned"
        options={options.members.map((member) => ({ value: member.id, label: member.name }))}
        errors={fields?.ownerMembershipId}
      />

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={contact?.notes ?? ''} />
      </div>

      <SubmitButton pendingLabel="Saving…">
        {contact ? 'Save changes' : 'Create contact'}
      </SubmitButton>
    </form>
  )
}

/* ---------------------------------- leads --------------------------------- */

export function LeadForm({
  orgSlug,
  options,
  lead,
}: {
  orgSlug: string
  options: PickerOptions
  lead?: {
    id: string
    name: string
    email: string | null
    phone: string | null
    companyName: string | null
    source: string
    status: string
    score: number
    notes: string | null
    ownerMembershipId: string | null
  }
}) {
  const action = lead
    ? updateLeadAction.bind(null, orgSlug, lead.id)
    : createLeadAction.bind(null, orgSlug)

  const [state, formAction] = useActionState<FormState, FormData>(action, null)
  const { fields, formError, success } = useFormFields(state)

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {success ? <Alert variant="success">{success}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field name="name" label="Name" required defaultValue={lead?.name} errors={fields?.name} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="email"
          label="Email"
          type="email"
          defaultValue={lead?.email ?? ''}
          errors={fields?.email}
        />
        <Field name="phone" label="Phone" defaultValue={lead?.phone ?? ''} errors={fields?.phone} />
        <Field
          name="companyName"
          label="Company"
          defaultValue={lead?.companyName ?? ''}
          errors={fields?.companyName}
        />
        <Field
          name="score"
          label="Score"
          type="number"
          min={0}
          max={100}
          defaultValue={String(lead?.score ?? 0)}
          errors={fields?.score}
        />
        <SelectField
          name="source"
          label="Source"
          defaultValue={lead?.source ?? 'OTHER'}
          placeholder="Select"
          options={LEAD_SOURCES.map((source) => ({ value: source, label: titleCase(source) }))}
          errors={fields?.source}
        />
        <SelectField
          name="status"
          label="Status"
          defaultValue={lead?.status ?? 'NEW'}
          placeholder="Select"
          options={LEAD_STATUSES.map((status) => ({ value: status, label: titleCase(status) }))}
          errors={fields?.status}
        />
      </div>

      <SelectField
        name="ownerMembershipId"
        label="Owner"
        defaultValue={lead?.ownerMembershipId ?? ''}
        placeholder="Unassigned"
        options={options.members.map((member) => ({ value: member.id, label: member.name }))}
        errors={fields?.ownerMembershipId}
      />

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={lead?.notes ?? ''} />
      </div>

      <SubmitButton pendingLabel="Saving…">{lead ? 'Save changes' : 'Create lead'}</SubmitButton>
    </form>
  )
}

/* ---------------------------------- deals --------------------------------- */

export function DealForm({
  orgSlug,
  options,
  pipelines,
  currency,
  deal,
}: {
  orgSlug: string
  options: PickerOptions
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>
  currency: string
  deal?: {
    id: string
    title: string
    pipelineId: string
    stageId: string
    companyId: string | null
    primaryContactId: string | null
    valueMinor: bigint
    expectedCloseDate: Date | null
    ownerMembershipId: string | null
  }
}) {
  const action = deal
    ? updateDealAction.bind(null, orgSlug, deal.id)
    : createDealAction.bind(null, orgSlug)

  const [state, formAction] = useActionState<FormState, FormData>(action, null)
  const { fields, formError, success } = useFormFields(state)

  const pipeline = pipelines.find((entry) => entry.id === (deal?.pipelineId ?? pipelines[0]?.id))

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {success ? <Alert variant="success">{success}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <Field
        name="title"
        label="Deal title"
        required
        defaultValue={deal?.title}
        errors={fields?.title}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="pipelineId"
          label="Pipeline"
          defaultValue={deal?.pipelineId ?? pipelines[0]?.id}
          placeholder="Select"
          options={pipelines.map((entry) => ({ value: entry.id, label: entry.name }))}
          errors={fields?.pipelineId}
        />
        <SelectField
          name="stageId"
          label="Stage"
          defaultValue={deal?.stageId ?? pipeline?.stages[0]?.id}
          placeholder="Select"
          options={(pipeline?.stages ?? []).map((stage) => ({
            value: stage.id,
            label: stage.name,
          }))}
          errors={fields?.stageId}
        />
        <Field
          name="valueMinor"
          label={`Value (${currency})`}
          inputMode="decimal"
          defaultValue={deal ? formatMinorForInput(deal.valueMinor, currency) : ''}
          errors={fields?.valueMinor}
          hint="Digits and a decimal point only."
        />
        <Field
          name="expectedCloseDate"
          label="Expected close"
          type="date"
          defaultValue={deal?.expectedCloseDate?.toISOString().slice(0, 10) ?? ''}
          errors={fields?.expectedCloseDate}
        />
        <SelectField
          name="companyId"
          label="Company"
          defaultValue={deal?.companyId ?? ''}
          options={options.companies.map((company) => ({ value: company.id, label: company.name }))}
          errors={fields?.companyId}
        />
        <SelectField
          name="primaryContactId"
          label="Primary contact"
          defaultValue={deal?.primaryContactId ?? ''}
          options={options.contacts.map((contact) => ({
            value: contact.id,
            label: `${contact.firstName} ${contact.lastName}`,
          }))}
          errors={fields?.primaryContactId}
        />
      </div>

      <SelectField
        name="ownerMembershipId"
        label="Owner"
        defaultValue={deal?.ownerMembershipId ?? ''}
        placeholder="Unassigned"
        options={options.members.map((member) => ({ value: member.id, label: member.name }))}
        errors={fields?.ownerMembershipId}
      />

      <SubmitButton pendingLabel="Saving…">{deal ? 'Save changes' : 'Create deal'}</SubmitButton>
    </form>
  )
}

/* -------------------------------- activities ------------------------------ */

export function ActivityForm({
  orgSlug,
  entityType,
  entityId,
}: {
  orgSlug: string
  entityType: 'Company' | 'Contact' | 'Lead' | 'Deal'
  entityId: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    logActivityAction.bind(null, orgSlug),
    null,
  )
  const { fields, formError } = useFormFields(state)

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />

      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <SelectField
          name="type"
          label="Type"
          defaultValue="NOTE"
          placeholder="Select"
          options={ACTIVITY_TYPES.map((type) => ({ value: type, label: titleCase(type) }))}
        />
        <Field name="subject" label="Subject" required errors={fields?.subject} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="body">Details</Label>
        <Textarea id="body" name="body" rows={3} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field
          name="dueAt"
          label="Follow up on"
          type="date"
          className="w-48"
          errors={fields?.dueAt}
        />
        <SubmitButton variant="outline" pendingLabel="Saving…">
          Log activity
        </SubmitButton>
      </div>
    </form>
  )
}

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')

/**
 * Minor units to an editable decimal string.
 *
 * Kept as string arithmetic so an amount never round-trips through a float on
 * its way into a form field.
 */
function formatMinorForInput(amountMinor: bigint, currency: string): string {
  const exponent = currency === 'JPY' || currency === 'KRW' ? 0 : 2
  if (exponent === 0) return amountMinor.toString()

  const negative = amountMinor < 0n
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exponent + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}
