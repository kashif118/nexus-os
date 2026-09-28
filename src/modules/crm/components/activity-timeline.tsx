import { Badge } from '@/components/ui/badge'

/**
 * Activity timeline.
 *
 * Shared by every CRM record because `Activity` is polymorphic — one component
 * rather than four near-identical ones.
 */
export interface TimelineActivity {
  id: string
  type: string
  subject: string
  body: string | null
  dueAt: Date | null
  completedAt: Date | null
  createdAt: Date
  owner: { user: { name: string } } | null
}

const TYPE_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning'> = {
  CALL: 'info',
  EMAIL: 'info',
  MEETING: 'warning',
  NOTE: 'neutral',
  TASK: 'success',
}

export function ActivityTimeline({ activities }: { activities: TimelineActivity[] }) {
  if (activities.length === 0) {
    return <p className="text-muted-foreground text-sm">No activity recorded yet.</p>
  }

  return (
    <ol className="space-y-4">
      {activities.map((activity) => {
        const overdue =
          activity.dueAt !== null && activity.completedAt === null && activity.dueAt < new Date()

        return (
          <li key={activity.id} className="border-border relative border-l pl-4">
            <span
              aria-hidden="true"
              className="bg-border absolute top-1.5 -left-[3px] size-1.5 rounded-full"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={TYPE_TONE[activity.type] ?? 'neutral'}>
                {activity.type.charAt(0) + activity.type.slice(1).toLowerCase()}
              </Badge>
              <span className="text-sm font-medium">{activity.subject}</span>
              {overdue ? <Badge variant="destructive">Overdue</Badge> : null}
              {activity.completedAt ? <Badge variant="success">Done</Badge> : null}
            </div>

            {activity.body ? (
              <p className="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">
                {activity.body}
              </p>
            ) : null}

            <p className="text-muted-foreground mt-1 text-xs">
              {activity.owner?.user.name ?? 'Someone'} ·{' '}
              <time dateTime={activity.createdAt.toISOString()}>
                {activity.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
              </time>
              {activity.dueAt ? ` · due ${activity.dueAt.toISOString().slice(0, 10)}` : ''}
            </p>
          </li>
        )
      })}
    </ol>
  )
}
