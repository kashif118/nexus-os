import type { Metadata } from 'next'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { PreferenceRowForm } from '@/modules/notifications/components/preference-form'
import { listPreferences, preferenceGroups } from '@/modules/notifications/queries'

export const metadata: Metadata = { title: 'Notification settings' }

export default async function NotificationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const preferences = await listPreferences(ctx)
  const groups = preferenceGroups()

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader
        title="Notification settings"
        description="These apply to you in this organization only. A setting you never touch uses the default shown."
      />

      {groups.map((group) => {
        const rows = preferences.filter((preference) => preference.group === group)
        if (rows.length === 0) return null

        return (
          <Card key={group}>
            <CardHeader>
              <CardTitle>{group}</CardTitle>
            </CardHeader>
            <CardContent className="divide-border divide-y py-0">
              {rows.map((preference) => (
                <PreferenceRowForm
                  key={preference.eventType}
                  orgSlug={orgSlug}
                  preference={preference}
                />
              ))}
            </CardContent>
          </Card>
        )
      })}

      <p className="text-muted-foreground text-xs">
        Digest delivery is recorded but not yet sent: the scheduled job that batches a day of
        notifications into one email is not part of this build.
      </p>
    </div>
  )
}
