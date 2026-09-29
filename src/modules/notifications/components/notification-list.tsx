'use client'

import { Check } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { EmptyState } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { relativeTime } from '@/lib/format'

import { markAllReadAction, markReadAction, type FormState } from '../actions'

export interface NotificationRow {
  id: string
  type: string
  title: string
  body: string | null
  href: string | null
  priority: string
  readAt: Date | null
  createdAt: Date
}

export function NotificationList({
  orgSlug,
  notifications,
}: {
  orgSlug: string
  notifications: NotificationRow[]
}) {
  const router = useRouter()
  const [readState, markRead] = useActionState<FormState, FormData>(
    markReadAction.bind(null, orgSlug),
    null,
  )
  const [allState, markAll] = useActionState<FormState, FormData>(
    markAllReadAction.bind(null, orgSlug),
    null,
  )

  useEffect(() => {
    if (readState?.ok || allState?.ok) router.refresh()
  }, [readState, allState, router])

  const unread = notifications.filter((notification) => notification.readAt === null)

  if (notifications.length === 0) {
    return (
      <EmptyState
        title="Nothing yet"
        description="Assignments, mentions and approvals you need to see will appear here."
      />
    )
  }

  return (
    <div className="space-y-3">
      {unread.length > 0 ? (
        <form action={markAll} className="flex justify-end">
          <SubmitButton size="sm" variant="ghost" pendingLabel="Marking…">
            <Check className="size-3.5" aria-hidden="true" />
            Mark all read
          </SubmitButton>
        </form>
      ) : null}

      <ul className="divide-border divide-y">
        {notifications.map((notification) => {
          const isUnread = notification.readAt === null

          return (
            <li
              key={notification.id}
              className={`flex items-start justify-between gap-4 py-3 ${isUnread ? '' : 'opacity-70'}`}
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  {isUnread ? (
                    <span
                      className="bg-primary size-1.5 shrink-0 rounded-full"
                      aria-label="Unread"
                    />
                  ) : null}
                  {notification.href ? (
                    <Link href={notification.href} className="text-sm font-medium hover:underline">
                      {notification.title}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{notification.title}</span>
                  )}
                  {notification.priority === 'HIGH' ? (
                    <Badge variant="warning">Needs attention</Badge>
                  ) : null}
                </div>
                {notification.body ? (
                  <p className="text-muted-foreground truncate text-xs">{notification.body}</p>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  {relativeTime(notification.createdAt)}
                </p>
              </div>

              {isUnread ? (
                <form action={markRead}>
                  <input type="hidden" name="ids" value={notification.id} />
                  <SubmitButton size="sm" variant="ghost" pendingLabel="…">
                    Mark read
                  </SubmitButton>
                </form>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
