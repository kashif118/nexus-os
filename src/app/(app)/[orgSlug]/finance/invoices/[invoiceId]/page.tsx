import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { formatQuantity } from '@/modules/finance/calculate'
import { InvoiceEditor } from '@/modules/finance/components/invoice-editor'
import { InvoiceControls, PaymentForm } from '@/modules/finance/components/invoice-controls'
import { getFinanceFormOptions, getInvoice } from '@/modules/finance/queries'

export const metadata: Metadata = { title: 'Invoice' }

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; invoiceId: string }>
}) {
  const { orgSlug, invoiceId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let invoice: Awaited<ReturnType<typeof getInvoice>>
  try {
    invoice = await getInvoice(ctx, invoiceId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const isDraft = invoice.status === 'DRAFT'
  const canEdit = isDraft && ctx.can('finance.invoice.update')
  const options = canEdit ? await getFinanceFormOptions(ctx) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title={invoice.number}
        description={
          <>
            <Link
              href={`/${orgSlug}/crm/companies/${invoice.company.id}`}
              className="hover:underline"
            >
              {invoice.company.name}
            </Link>
            {invoice.project ? (
              <>
                {' · '}
                <Link
                  href={`/${orgSlug}/projects/${invoice.project.id}`}
                  className="hover:underline"
                >
                  {invoice.project.key}
                </Link>
              </>
            ) : null}
          </>
        }
        actions={
          <div className="flex items-center gap-3">
            <Badge
              variant={
                invoice.status === 'PAID'
                  ? 'success'
                  : invoice.status === 'OVERDUE'
                    ? 'destructive'
                    : 'neutral'
              }
            >
              {invoice.status.charAt(0) + invoice.status.slice(1).toLowerCase()}
            </Badge>
            <span className="tabular text-lg font-semibold">
              {formatMoney(invoice.totalMinor, invoice.currency)}
            </span>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {canEdit && options ? (
            <Card>
              <CardHeader>
                <CardTitle>Edit draft</CardTitle>
                <CardDescription>
                  Totals are recomputed on the server from these lines every time you save.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <InvoiceEditor
                  orgSlug={orgSlug}
                  currency={ctx.org.currency}
                  options={{ companies: options.companies, projects: options.projects }}
                  invoice={{
                    id: invoice.id,
                    companyId: invoice.companyId,
                    projectId: invoice.projectId,
                    issueDate: invoice.issueDate,
                    dueDate: invoice.dueDate,
                    notes: invoice.notes,
                    terms: invoice.terms,
                    items: invoice.items.map((item) => ({
                      description: item.description,
                      quantityScaled: item.quantityScaled,
                      unitPriceMinor: item.unitPriceMinor,
                      discountBasisPoints: item.discountBasisPoints,
                      taxBasisPoints: item.taxBasisPoints,
                    })),
                  }}
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Lines</CardTitle>
                {!isDraft ? (
                  <CardDescription>
                    Issued invoices are not edited in place. Void this one and reissue if it is
                    wrong.
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b text-left">
                      <th className="pb-2 font-medium">Description</th>
                      <th className="pb-2 text-right font-medium">Qty</th>
                      <th className="pb-2 text-right font-medium">Unit</th>
                      <th className="pb-2 text-right font-medium">Tax</th>
                      <th className="pb-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.items.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="py-2 pr-2">{item.description}</td>
                        <td className="tabular py-2 pr-2 text-right">
                          {formatQuantity(item.quantityScaled)}
                        </td>
                        <td className="tabular py-2 pr-2 text-right">
                          {formatMoney(item.unitPriceMinor, invoice.currency)}
                        </td>
                        <td className="tabular py-2 pr-2 text-right">
                          {formatMoney(item.lineTaxMinor, invoice.currency)}
                        </td>
                        <td className="tabular py-2 text-right">
                          {formatMoney(item.lineTotalMinor, invoice.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <dl className="mt-4 ml-auto max-w-xs space-y-1 text-sm">
                  <Row
                    label="Subtotal"
                    value={formatMoney(invoice.subtotalMinor, invoice.currency)}
                  />
                  {invoice.discountMinor > 0n ? (
                    <Row
                      label="Discount"
                      value={`−${formatMoney(invoice.discountMinor, invoice.currency)}`}
                    />
                  ) : null}
                  {invoice.taxMinor > 0n ? (
                    <Row label="Tax" value={formatMoney(invoice.taxMinor, invoice.currency)} />
                  ) : null}
                  <Row
                    label="Total"
                    value={formatMoney(invoice.totalMinor, invoice.currency)}
                    emphasis
                  />
                  <Row
                    label="Paid"
                    value={formatMoney(invoice.amountPaidMinor, invoice.currency)}
                  />
                  <Row
                    label="Balance"
                    value={formatMoney(invoice.balanceMinor, invoice.currency)}
                    emphasis
                  />
                </dl>

                {invoice.notes ? (
                  <p className="text-muted-foreground mt-4 text-sm whitespace-pre-wrap">
                    {invoice.notes}
                  </p>
                ) : null}
                {invoice.terms ? (
                  <p className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">
                    {invoice.terms}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Payments</CardTitle>
              <CardDescription>
                The paid amount is the sum of these rows, never an incremented counter.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {invoice.payments.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing received yet.</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {invoice.payments.map((payment) => (
                    <li key={payment.id} className="flex items-center justify-between gap-3 py-2">
                      <div>
                        <p className="font-medium">
                          {formatMoney(payment.amountMinor, payment.currency)}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {payment.receivedAt.toISOString().slice(0, 10)} ·{' '}
                          {payment.method.charAt(0) +
                            payment.method.slice(1).toLowerCase().replace(/_/g, ' ')}
                          {payment.reference ? ` · ${payment.reference}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {ctx.can('finance.invoice.payment.record') &&
              (invoice.status === 'SENT' || invoice.status === 'OVERDUE') ? (
                <div className="border-t pt-4">
                  <PaymentForm
                    orgSlug={orgSlug}
                    invoiceId={invoice.id}
                    currency={invoice.currency}
                    balanceLabel={formatMoney(invoice.balanceMinor, invoice.currency)}
                  />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="space-y-1">
                <Row label="Issued" value={invoice.issueDate.toISOString().slice(0, 10)} />
                <Row label="Due" value={invoice.dueDate.toISOString().slice(0, 10)} />
                {invoice.sentAt ? (
                  <Row label="Sent" value={invoice.sentAt.toISOString().slice(0, 10)} />
                ) : null}
                {invoice.paidAt ? (
                  <Row label="Settled" value={invoice.paidAt.toISOString().slice(0, 10)} />
                ) : null}
              </dl>

              <InvoiceControls
                orgSlug={orgSlug}
                invoiceId={invoice.id}
                status={invoice.status}
                hasPayments={invoice.payments.length > 0}
                canSend={ctx.can('finance.invoice.send')}
                canVoid={ctx.can('finance.invoice.void')}
                canDelete={ctx.can('finance.invoice.delete')}
              />
            </CardContent>
          </Card>

          {invoice.contact ? (
            <Card>
              <CardHeader>
                <CardTitle>Billing contact</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p>
                  {invoice.contact.firstName} {invoice.contact.lastName}
                </p>
                {invoice.contact.email ? (
                  <p className="text-muted-foreground text-xs">{invoice.contact.email}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${emphasis ? 'border-t pt-1' : ''}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular ${emphasis ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}
