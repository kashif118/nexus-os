'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useMemo, useState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatMoney, parseAmount } from '@/lib/money'

import { createInvoiceAction, updateInvoiceAction, type FormState } from '../actions'
import { calculateInvoice, formatQuantity, parseQuantity } from '../calculate'

/**
 * Invoice editor.
 *
 * The totals shown while typing are computed by the SAME pure functions the
 * server uses, so the preview cannot disagree with what is stored. They are a
 * preview only: the form posts line items, and the server recomputes everything
 * from scratch. A total the client could send is a total an attacker could
 * choose.
 */

interface LineDraft {
  key: string
  description: string
  quantity: string
  unitPrice: string
  discountPercent: string
  taxPercent: string
}

const emptyLine = (): LineDraft => ({
  key: Math.random().toString(36).slice(2),
  description: '',
  quantity: '1',
  unitPrice: '',
  discountPercent: '',
  taxPercent: '',
})

export interface InvoiceFormOptions {
  companies: Array<{ id: string; name: string }>
  projects: Array<{ id: string; key: string; name: string }>
}

export function InvoiceEditor({
  orgSlug,
  currency,
  options,
  invoice,
}: {
  orgSlug: string
  currency: string
  options: InvoiceFormOptions
  invoice?: {
    id: string
    companyId: string
    projectId: string | null
    issueDate: Date
    dueDate: Date
    notes: string | null
    terms: string | null
    items: Array<{
      description: string
      quantityScaled: number
      unitPriceMinor: bigint
      discountBasisPoints: number
      taxBasisPoints: number
    }>
  }
}) {
  const action = invoice
    ? updateInvoiceAction.bind(null, orgSlug, invoice.id)
    : createInvoiceAction.bind(null, orgSlug)

  const [state, formAction] = useActionState<FormState, FormData>(action, null)
  const router = useRouter()

  // A newly created draft opens on its own page, where it can be issued.
  const createdId = !invoice && state?.ok ? state.data.id : undefined
  useEffect(() => {
    if (createdId) router.push(`/${orgSlug}/finance/invoices/${createdId}`)
  }, [createdId, orgSlug, router])

  const [lines, setLines] = useState<LineDraft[]>(() =>
    invoice && invoice.items.length > 0
      ? invoice.items.map((item) => ({
          key: Math.random().toString(36).slice(2),
          description: item.description,
          quantity: formatQuantity(item.quantityScaled),
          unitPrice: minorToInput(item.unitPriceMinor, currency),
          discountPercent: item.discountBasisPoints ? String(item.discountBasisPoints / 100) : '',
          taxPercent: item.taxBasisPoints ? String(item.taxBasisPoints / 100) : '',
        }))
      : [emptyLine()],
  )

  /** Live preview, using the server's own arithmetic. */
  const preview = useMemo(() => {
    const parsed = lines.map((line) => ({
      quantityScaled: parseQuantity(line.quantity || '0') ?? 0,
      quantityScale: 3,
      unitPriceMinor: parseAmount(line.unitPrice || '0', currency) ?? 0n,
      discountBasisPoints: percentToBasisPoints(line.discountPercent),
      taxBasisPoints: percentToBasisPoints(line.taxPercent),
    }))
    return calculateInvoice(parsed)
  }, [lines, currency])

  /** Serialised for the action; the server re-validates every field. */
  const linesJson = JSON.stringify(
    lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent,
      taxPercent: line.taxPercent,
    })),
  )

  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  const update = (key: string, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)))

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}
      {fields?.lines ? <Alert variant="destructive">{fields.lines.join(' ')}</Alert> : null}

      <input type="hidden" name="lines" value={linesJson} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="companyId">Client</Label>
          <NativeSelect id="companyId" name="companyId" defaultValue={invoice?.companyId ?? ''}>
            <option value="">Choose a client…</option>
            {options.companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </NativeSelect>
          {fields?.companyId ? (
            <p className="text-destructive text-xs">{fields.companyId.join(' ')}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="projectId">Project</Label>
          <NativeSelect id="projectId" name="projectId" defaultValue={invoice?.projectId ?? ''}>
            <option value="">None</option>
            {options.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.key} · {project.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <Field
          name="issueDate"
          label="Issue date"
          type="date"
          required
          defaultValue={(invoice?.issueDate ?? new Date()).toISOString().slice(0, 10)}
          errors={fields?.issueDate}
        />
        <Field
          name="dueDate"
          label="Due date"
          type="date"
          required
          defaultValue={(invoice?.dueDate ?? addDays(new Date(), 30)).toISOString().slice(0, 10)}
          errors={fields?.dueDate}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Lines</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((current) => [...current, emptyLine()])}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add line
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="pb-2 font-medium">Description</th>
                <th className="w-24 pb-2 text-right font-medium">Qty</th>
                <th className="w-32 pb-2 text-right font-medium">Unit price</th>
                <th className="w-24 pb-2 text-right font-medium">Disc %</th>
                <th className="w-24 pb-2 text-right font-medium">Tax %</th>
                <th className="w-32 pb-2 text-right font-medium">Total</th>
                <th className="w-10 pb-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key} className="border-b last:border-0">
                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} description`}
                      value={line.description}
                      onChange={(event) => update(line.key, { description: event.target.value })}
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} quantity`}
                      inputMode="decimal"
                      className="text-right"
                      value={line.quantity}
                      onChange={(event) => update(line.key, { quantity: event.target.value })}
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} unit price`}
                      inputMode="decimal"
                      className="text-right"
                      value={line.unitPrice}
                      onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} discount percent`}
                      inputMode="decimal"
                      className="text-right"
                      value={line.discountPercent}
                      onChange={(event) =>
                        update(line.key, { discountPercent: event.target.value })
                      }
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} tax percent`}
                      inputMode="decimal"
                      className="text-right"
                      value={line.taxPercent}
                      onChange={(event) => update(line.key, { taxPercent: event.target.value })}
                    />
                  </td>
                  <td className="tabular py-2 pr-2 text-right">
                    {formatMoney(preview.lines[index]?.lineTotalMinor ?? 0n, currency)}
                  </td>
                  <td className="py-2">
                    {lines.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setLines((current) => current.filter((entry) => entry.key !== line.key))
                        }
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Remove line ${index + 1}`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Preview only. The server recomputes all of this from the lines. */}
        <dl className="ml-auto max-w-xs space-y-1 text-sm">
          <Row label="Subtotal" value={formatMoney(preview.totals.subtotalMinor, currency)} />
          {preview.totals.discountMinor > 0n ? (
            <Row
              label="Discount"
              value={`−${formatMoney(preview.totals.discountMinor, currency)}`}
            />
          ) : null}
          {preview.totals.taxMinor > 0n ? (
            <Row label="Tax" value={formatMoney(preview.totals.taxMinor, currency)} />
          ) : null}
          <Row label="Total" value={formatMoney(preview.totals.totalMinor, currency)} emphasis />
        </dl>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" rows={3} defaultValue={invoice?.notes ?? ''} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms">Terms</Label>
          <Textarea id="terms" name="terms" rows={3} defaultValue={invoice?.terms ?? ''} />
        </div>
      </div>

      <SubmitButton pendingLabel="Saving…">
        {invoice ? 'Save invoice' : 'Create draft invoice'}
      </SubmitButton>
    </form>
  )
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${emphasis ? 'border-t pt-1' : ''}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular ${emphasis ? 'text-base font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}

const percentToBasisPoints = (value: string): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0
}

function minorToInput(amountMinor: bigint, currency: string): string {
  const exponent = currency === 'JPY' || currency === 'KRW' ? 0 : 2
  if (exponent === 0) return amountMinor.toString()
  const digits = (amountMinor < 0n ? -amountMinor : amountMinor)
    .toString()
    .padStart(exponent + 1, '0')
  return `${amountMinor < 0n ? '-' : ''}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}
