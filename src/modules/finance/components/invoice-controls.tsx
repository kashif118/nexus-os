'use client'

import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'

import {
  deleteInvoiceAction,
  recordPaymentAction,
  sendInvoiceAction,
  voidInvoiceAction,
  type FormState,
} from '../actions'
import { PAYMENT_METHODS } from '../schema'

/**
 * Lifecycle controls for a single invoice.
 *
 * Which buttons appear is decided on the server and passed in: hiding a control
 * is a courtesy, not a protection. Every action re-checks the permission and the
 * invoice state before it touches a row.
 */
export function InvoiceControls({
  orgSlug,
  invoiceId,
  status,
  hasPayments,
  canSend,
  canVoid,
  canDelete,
}: {
  orgSlug: string
  invoiceId: string
  status: string
  hasPayments: boolean
  canSend: boolean
  canVoid: boolean
  canDelete: boolean
}) {
  const router = useRouter()
  const [sendState, sendAction] = useActionState<FormState, FormData>(
    sendInvoiceAction.bind(null, orgSlug),
    null,
  )
  const [voidState, voidAction] = useActionState<FormState, FormData>(
    voidInvoiceAction.bind(null, orgSlug),
    null,
  )
  const [deleteState, deleteAction] = useActionState<FormState, FormData>(
    deleteInvoiceAction.bind(null, orgSlug),
    null,
  )
  const [confirmVoid, setConfirmVoid] = useState(false)

  useEffect(() => {
    if (deleteState?.ok) router.replace(`/${orgSlug}/finance/invoices`)
  }, [deleteState, orgSlug, router])

  const error = [sendState, voidState, deleteState].find((state) => state && !state.ok)

  const isDraft = status === 'DRAFT'
  const isOpen = status === 'SENT' || status === 'OVERDUE'

  return (
    <div className="space-y-3">
      {error && !error.ok ? <Alert variant="destructive">{error.error.message}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        {isDraft && canSend ? (
          <form action={sendAction}>
            <input type="hidden" name="id" value={invoiceId} />
            <SubmitButton size="sm" pendingLabel="Issuing…">
              Issue invoice
            </SubmitButton>
          </form>
        ) : null}

        {isDraft && canDelete ? (
          <form action={deleteAction}>
            <input type="hidden" name="id" value={invoiceId} />
            <SubmitButton size="sm" variant="outline" pendingLabel="Deleting…">
              Delete draft
            </SubmitButton>
          </form>
        ) : null}

        {isOpen && canVoid && !confirmVoid ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmVoid(true)}>
            Void invoice
          </Button>
        ) : null}
      </div>

      {isOpen && canVoid && confirmVoid ? (
        <form action={voidAction} className="space-y-2 rounded-md border p-3">
          <input type="hidden" name="id" value={invoiceId} />
          <p className="text-muted-foreground text-xs">
            Voiding cancels the invoice. An issued invoice is never edited in place — reissue a new
            one instead, so the sequence stays auditable.
          </p>
          {hasPayments ? (
            <Alert variant="destructive">
              This invoice has payments recorded against it and cannot be voided. Reverse the
              payments first.
            </Alert>
          ) : null}
          <Label htmlFor="voidReason" className="text-xs">
            Reason
          </Label>
          <Input id="voidReason" name="reason" placeholder="Why is it being voided?" />
          <div className="flex gap-2">
            <SubmitButton size="sm" variant="destructive" pendingLabel="Voiding…">
              Confirm void
            </SubmitButton>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmVoid(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

/** Record a payment received against an invoice. */
export function PaymentForm({
  orgSlug,
  invoiceId,
  currency,
  balanceLabel,
}: {
  orgSlug: string
  invoiceId: string
  currency: string
  balanceLabel: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    recordPaymentAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <input type="hidden" name="invoiceId" value={invoiceId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          name="amount"
          label={`Amount (${currency})`}
          inputMode="decimal"
          placeholder={balanceLabel}
          required
          errors={fields?.amount}
        />
        <Field
          name="receivedAt"
          label="Received on"
          type="date"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
          errors={fields?.receivedAt}
        />
        <div className="space-y-1.5">
          <Label htmlFor="method">Method</Label>
          <NativeSelect id="method" name="method" defaultValue="BANK_TRANSFER">
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {method.charAt(0) + method.slice(1).toLowerCase().replace(/_/g, ' ')}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Field name="reference" label="Reference" errors={fields?.reference} />
      </div>

      <SubmitButton size="sm" pendingLabel="Recording…">
        Record payment
      </SubmitButton>
    </form>
  )
}
