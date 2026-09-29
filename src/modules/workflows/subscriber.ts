import { registerSubscriber, type DomainEvent, type Subscriber } from '@/kernel/events'

import { runQueued, startRunsForEvent } from './engine'

/**
 * The workflow subscriber.
 *
 * Matching an event to workflows and executing the resulting runs are separate
 * steps on purpose. Matching is cheap and must not fail; execution can be slow,
 * can wait on a person, and can fail — so a run is a persisted row before any
 * of it starts. If the process dies here, the run is QUEUED and the cron sweep
 * picks it up.
 *
 * A failure inside a run never propagates back to this subscriber: the run is
 * marked FAILED and the event is still delivered. One badly configured workflow
 * must not stop notifications for everyone.
 */
export const workflowSubscriber: Subscriber = {
  name: 'workflows',

  async handle(event: DomainEvent) {
    const runIds = await startRunsForEvent({
      id: event.id,
      type: event.type,
      organizationId: event.organizationId,
      entityType: event.entityType,
      entityId: event.entityId,
      payload: event.payload,
    })

    if (runIds.length === 0) return

    try {
      await runQueued(runIds.length)
    } catch (error) {
      // The runs stay QUEUED and the sweep retries them.
      console.error('[workflows] run execution failed', error)
    }
  },
}

registerSubscriber(workflowSubscriber)
