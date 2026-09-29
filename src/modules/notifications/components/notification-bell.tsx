import { Bell } from 'lucide-react'
import Link from 'next/link'

import type { Ctx } from '@/kernel/tenancy/ctx'

import { countUnread } from '../queries'

/**
 * The header bell.
 *
 * A Server Component: the count comes from the same request that renders the
 * shell, so there is no polling endpoint and no client-side fetch. It is
 * therefore as fresh as the page — which for a notification count is the right
 * trade, given the alternative is a request every few seconds from every open
 * tab.
 */
export async function NotificationBell({ ctx }: { ctx: Ctx }) {
  const unread = await countUnread(ctx)

  return (
    <Link
      href={`/${ctx.orgSlug}/notifications`}
      className="hover:bg-accent relative inline-flex size-9 items-center justify-center rounded-md transition-colors"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      <Bell className="size-4" aria-hidden="true" />
      {unread > 0 ? (
        <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-[10px] leading-4 font-medium">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  )
}
