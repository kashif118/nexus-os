import type { DomainEvent, EventType } from '@/kernel/events'

/**
 * Turn an event into the words a person reads — pure, and tested.
 *
 * The event payload carries everything needed, captured at emit time. Looking
 * the entity up here would show its CURRENT state, so a notification saying
 * "moved to Negotiation" would silently start saying "moved to Closed" the
 * moment someone else moved it again.
 */

export interface RenderedNotification {
  title: string
  body?: string | undefined
  href?: string | undefined
  priority: 'LOW' | 'NORMAL' | 'HIGH'
}

const text = (payload: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export function renderNotification(
  event: DomainEvent,
  orgSlug: string,
): RenderedNotification | null {
  const { payload } = event
  const actor = text(payload, 'actorName', 'Someone')

  switch (event.type satisfies EventType) {
    case 'task.assigned':
      return {
        title: `${actor} assigned you "${text(payload, 'title', 'a task')}"`,
        body: text(payload, 'projectName') || undefined,
        href: `/${orgSlug}/tasks/${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'task.mentioned':
      return {
        title: `${actor} mentioned you`,
        body: text(payload, 'excerpt') || undefined,
        href: `/${orgSlug}/tasks/${event.entityId}`,
        priority: 'HIGH',
      }

    case 'task.commented':
      return {
        title: `${actor} commented on "${text(payload, 'title', 'a task')}"`,
        body: text(payload, 'excerpt') || undefined,
        href: `/${orgSlug}/tasks/${event.entityId}`,
        priority: 'LOW',
      }

    case 'task.due.soon':
      return {
        title: `"${text(payload, 'title', 'A task')}" is due ${text(payload, 'dueLabel', 'soon')}`,
        href: `/${orgSlug}/tasks/${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'project.member.added':
      return {
        title: `${actor} added you to ${text(payload, 'name', 'a project')}`,
        href: `/${orgSlug}/projects/${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'project.health.degraded':
      return {
        title: `${text(payload, 'name', 'A project')} is now ${text(payload, 'health', 'at risk').toLowerCase()}`,
        body: text(payload, 'reason') || undefined,
        href: `/${orgSlug}/projects/${event.entityId}`,
        priority: 'HIGH',
      }

    case 'deal.stage.changed':
      return {
        title: `${actor} moved "${text(payload, 'title', 'a deal')}" to ${text(payload, 'stageName', 'a new stage')}`,
        href: `/${orgSlug}/crm/deals/${event.entityId}`,
        priority: 'LOW',
      }

    case 'deal.won':
      return {
        title: `"${text(payload, 'title', 'A deal')}" was won`,
        body: text(payload, 'value') || undefined,
        href: `/${orgSlug}/crm/deals/${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'expense.submitted':
      return {
        title: `${actor} submitted an expense for approval`,
        body: text(payload, 'amount') || undefined,
        href: `/${orgSlug}/finance/expenses?expense=${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'expense.decided':
      return {
        title: `Your expense was ${text(payload, 'decision', 'decided').toLowerCase()}`,
        body: text(payload, 'note') || undefined,
        href: `/${orgSlug}/finance/expenses?expense=${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'invoice.paid':
      return {
        title: `${text(payload, 'number', 'An invoice')} was paid in full`,
        body: text(payload, 'amount') || undefined,
        href: `/${orgSlug}/finance/invoices/${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'invoice.overdue':
      return {
        title: `${text(payload, 'number', 'An invoice')} is overdue`,
        body: text(payload, 'amount') || undefined,
        href: `/${orgSlug}/finance/invoices/${event.entityId}`,
        priority: 'HIGH',
      }

    case 'document.shared':
      return {
        title: `${actor} shared "${text(payload, 'name', 'a document')}" with you`,
        href: `/${orgSlug}/documents/${event.entityId}`,
        priority: 'NORMAL',
      }

    case 'member.joined':
      return {
        title: `${text(payload, 'name', 'Someone')} joined the organization`,
        href: `/${orgSlug}/settings/members`,
        priority: 'LOW',
      }

    default:
      // An event with no rendering is not an error: it may exist only to drive
      // the activity feed or the search index.
      return null
  }
}

/** The plain-text email for the same event. */
export function renderEmail(
  rendered: RenderedNotification,
  recipientName: string,
  appUrl: string,
): { subject: string; text: string } {
  const link = rendered.href ? new URL(rendered.href, appUrl).toString() : appUrl

  return {
    subject: rendered.title,
    text: [
      `Hello ${recipientName},`,
      '',
      rendered.title,
      ...(rendered.body ? ['', rendered.body] : []),
      '',
      link,
      '',
      'Change what you are emailed about in your notification settings.',
    ].join('\n'),
  }
}
