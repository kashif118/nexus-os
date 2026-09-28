import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import { ActivityTimeline } from '@/modules/crm/components/activity-timeline'
import { ActivityForm, ContactForm } from '@/modules/crm/components/crm-forms'
import { getContact, getPickerOptions } from '@/modules/crm/queries'

export const metadata: Metadata = { title: 'Contact' }

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; contactId: string }>
}) {
  const { orgSlug, contactId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let contact: Awaited<ReturnType<typeof getContact>>
  try {
    contact = await getContact(ctx, contactId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const options = await getPickerOptions(ctx)

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${contact.firstName} ${contact.lastName}`}
        description={
          [contact.position, contact.company?.name].filter(Boolean).join(' · ') || undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {ctx.can('crm.contact.update') ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <ContactForm orgSlug={orgSlug} options={options} contact={contact} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <ActivityForm orgSlug={orgSlug} entityType="Contact" entityId={contact.id} />
              <ActivityTimeline activities={contact.activities} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {contact.email ? <Row label="Email" value={contact.email} /> : null}
              {contact.phone ? <Row label="Phone" value={contact.phone} /> : null}
              {contact.company ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Company</span>
                  <Link
                    href={`/${orgSlug}/crm/companies/${contact.company.id}`}
                    className="font-medium hover:underline"
                  >
                    {contact.company.name}
                  </Link>
                </div>
              ) : null}
              {contact.owner ? <Row label="Owner" value={contact.owner.user.name} /> : null}
            </CardContent>
          </Card>

          {ctx.can('crm.deal.read') && contact.deals.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Deals</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-border divide-y text-sm">
                  {contact.deals.map((deal) => (
                    <li key={deal.id} className="flex items-center justify-between gap-2 py-2">
                      <Link
                        href={`/${orgSlug}/crm/deals/${deal.id}`}
                        className="truncate font-medium hover:underline"
                      >
                        {deal.title}
                      </Link>
                      {ctx.can('crm.deal.value.view') ? (
                        <Badge variant="neutral">
                          {formatMoney(deal.valueMinor, deal.currency)}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
