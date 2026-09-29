import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/feedback/states'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { NotificationList } from '@/modules/notifications/components/notification-list'
import { listNotifications } from '@/modules/notifications/queries'

export const metadata: Metadata = { title: 'Notifications' }

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const resolved = await searchParams
  const filter = Array.isArray(resolved.filter) ? resolved.filter[0] : resolved.filter
  const unreadOnly = filter === 'unread'

  const notifications = await listNotifications(ctx, { unreadOnly, limit: 50 })

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader
        title="Notifications"
        description="Only yours. Nobody else can read this list."
        actions={
          <Link
            href={`/${orgSlug}/settings/notifications`}
            className="text-muted-foreground text-sm hover:underline"
          >
            Settings
          </Link>
        }
      />

      <nav className="flex gap-1 text-xs" aria-label="Filter">
        <Link
          href={`/${orgSlug}/notifications`}
          className={`rounded-md px-2 py-1 ${!unreadOnly ? 'bg-accent' : 'hover:bg-accent/60'}`}
        >
          All
        </Link>
        <Link
          href={`/${orgSlug}/notifications?filter=unread`}
          className={`rounded-md px-2 py-1 ${unreadOnly ? 'bg-accent' : 'hover:bg-accent/60'}`}
        >
          Unread
        </Link>
      </nav>

      <NotificationList orgSlug={orgSlug} notifications={notifications} />
    </div>
  )
}
