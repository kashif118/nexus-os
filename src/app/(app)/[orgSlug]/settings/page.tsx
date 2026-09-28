import type { Metadata } from 'next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { OrganizationSettingsForm } from '@/modules/organizations/components/organization-settings-form'
import { getOrganization } from '@/modules/organizations/queries'

export const metadata: Metadata = { title: 'Organization settings' }

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  const organization = await getOrganization(ctx)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Organization settings</h1>
        <p className="text-muted-foreground text-sm">
          Defaults used across reporting, invoicing and scheduling.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            The web address <code className="font-mono">/{organization.slug}</code> cannot be
            changed yet — links and bookmarks depend on it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationSettingsForm
            orgSlug={orgSlug}
            readOnly={!ctx.isOwner}
            values={{
              name: organization.name,
              description: organization.description,
              industry: organization.industry,
              timezone: organization.timezone,
              currency: organization.currency,
              country: organization.country,
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
