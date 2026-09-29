import type { Metadata } from 'next'

import { EmptyState, PageHeader } from '@/components/feedback/states'
import { Card, CardContent } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { relativeTime } from '@/modules/notifications/components/notification-list'
import { listActivity } from '@/modules/notifications/queries'

export const metadata: Metadata = { title: 'Activity' }

/**
 * The organization activity feed.
 *
 * Every event writes one entry here whether or not anyone was notified, so the
 * feed is a record of what happened rather than a record of what people had
 * switched on. It is org-scoped by the Prisma extension; there is no way to read
 * another tenant's feed.
 */
export default async function ActivityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const activity = await listActivity(ctx, { limit: 50 })

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader
        title="Activity"
        description="What has happened across this organization, newest first."
      />

      <Card>
        <CardContent className="pt-6">
          {activity.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              description="Assignments, stage changes and approvals appear here as they happen."
            />
          ) : (
            <ul className="divide-border divide-y text-sm">
              {activity.map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <p>
                      <span className="font-medium">{entry.entityType}</span>{' '}
                      <span className="text-muted-foreground">{entry.verb}</span>
                    </p>
                    {entry.summary ? (
                      <p className="text-muted-foreground truncate text-xs">{entry.summary}</p>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {relativeTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
