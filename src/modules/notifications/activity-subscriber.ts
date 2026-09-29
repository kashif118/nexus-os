import { registerSubscriber, type DomainEvent, type Subscriber } from '@/kernel/events'

import * as repository from './repository'

/**
 * The activity feed subscriber.
 *
 * Every event becomes one feed entry, whether or not anybody is notified about
 * it. The two are separate on purpose: the feed is the record of what happened
 * to a thing, and it should not have gaps because nobody happened to have that
 * notification switched on.
 *
 * Registered as its own subscriber rather than as a branch inside the notifier
 * so that a failure to write a feed entry never costs somebody a notification,
 * and vice versa.
 */
export const activitySubscriber: Subscriber = {
  name: 'activity-feed',

  async handle(event: DomainEvent) {
    await repository.writeActivity({
      organizationId: event.organizationId,
      entityType: event.entityType,
      entityId: event.entityId,
      actorId: event.actorId,
      verb: verbFor(event.type),
      summary: summaryOf(event),
    })
  },
}

registerSubscriber(activitySubscriber)

/** Past tense, in the words a person would use. */
function verbFor(type: string): string {
  const [, ...rest] = type.split('.')
  return rest.join(' ') || type
}

function summaryOf(event: DomainEvent): string | null {
  const payload = event.payload
  const parts: string[] = []

  for (const key of ['title', 'name', 'number', 'stageName', 'decision', 'amount']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) parts.push(value)
  }

  return parts.length > 0 ? parts.join(' · ').slice(0, 300) : null
}
