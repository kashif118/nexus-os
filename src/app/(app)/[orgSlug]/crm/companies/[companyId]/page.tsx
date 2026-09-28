import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { isAppError } from '@/kernel/errors'
import { formatMoney } from '@/lib/money'
import { ActivityTimeline } from '@/modules/crm/components/activity-timeline'
import { ActivityForm, CompanyForm } from '@/modules/crm/components/crm-forms'
import { getCompany, getPickerOptions } from '@/modules/crm/queries'

export const metadata: Metadata = { title: 'Company' }

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; companyId: string }>
}) {
  const { orgSlug, companyId } = await params
  const ctx = await requireCtxPage(orgSlug)

  // A record in another organization resolves to nothing through the scoped
  // client, so this is 404 rather than 403.
  let company: Awaited<ReturnType<typeof getCompany>>
  try {
    company = await getCompany(ctx, companyId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const options = await getPickerOptions(ctx)
  const canEdit = ctx.can('crm.company.update')

  return (
    <div className="space-y-6">
      <PageHeader
        title={company.name}
        description={[company.industry, company.domain].filter(Boolean).join(' · ') || undefined}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {canEdit ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <CompanyForm orgSlug={orgSlug} options={options} company={company} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <ActivityForm orgSlug={orgSlug} entityType="Company" entityId={company.id} />
              <ActivityTimeline activities={company.activities} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Contacts ({company.contacts.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {company.contacts.length === 0 ? (
                <p className="text-muted-foreground text-sm">No contacts yet.</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {company.contacts.map((contact) => (
                    <li key={contact.id} className="py-2">
                      <Link
                        href={`/${orgSlug}/crm/contacts/${contact.id}`}
                        className="font-medium hover:underline"
                      >
                        {contact.firstName} {contact.lastName}
                      </Link>
                      {contact.position ? (
                        <p className="text-muted-foreground text-xs">{contact.position}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {ctx.can('crm.deal.read') ? (
            <Card>
              <CardHeader>
                <CardTitle>Deals ({company.deals.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {company.deals.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No deals yet.</p>
                ) : (
                  <ul className="divide-border divide-y text-sm">
                    {company.deals.map((deal) => (
                      <li key={deal.id} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <Link
                            href={`/${orgSlug}/crm/deals/${deal.id}`}
                            className="truncate font-medium hover:underline"
                          >
                            {deal.title}
                          </Link>
                          <p className="text-muted-foreground text-xs">{deal.stage.name}</p>
                        </div>
                        {ctx.can('crm.deal.value.view') ? (
                          <Badge variant="neutral">
                            {formatMoney(deal.valueMinor, deal.currency)}
                          </Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
