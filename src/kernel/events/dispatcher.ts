import { getSystemDb } from '@/lib/db'

import { isEventType, type EventType } from './catalogue'
import { log } from '@/kernel/observability/logger'

/**
 * The outbox drain.
 *
 * Reads committed events and hands each to every registered subscriber. Three
 * properties, each of which exists because of a specific failure:
 *
 * 1. **Idempotent per subscriber.** An `OutboxDelivery` row is claimed before
 *    the handler runs, so the same event cannot notify the same person twice
 *    even if the drain runs concurrently or retries.
 * 2. **Independent subscribers.** One failing subscriber marks only its own
 *    delivery failed; the others still run, and the event is not reprocessed
 *    for them.
 * 3. **Bounded retries.** An event that has failed `MAX_ATTEMPTS` times stops
 *    being retried and is left FAILED for a human, rather than looping forever
 *    on a poison message.
 */

export interface DomainEvent {
  id: string
  type: EventType
  organizationId: string
  entityType: string
  entityId: string
  actorId: string | null
  occurredAt: Date
  payload: Record<string, unknown>
}

export interface Subscriber {
  /** Stable name. Changing it re-delivers every past event to the new name. */
  name: string
  /** Event types this subscriber wants. Empty means all of them. */
  types?: EventType[]
  handle(event: DomainEvent): Promise<void>
}

const MAX_ATTEMPTS = 5
const SUBSCRIBERS = new Map<string, Subscriber>()

export function registerSubscriber(subscriber: Subscriber): void {
  if (SUBSCRIBERS.has(subscriber.name)) {
    throw new Error(`Duplicate event subscriber: ${subscriber.name}`)
  }
  SUBSCRIBERS.set(subscriber.name, subscriber)
}

/** Test seam: drop registrations so a suite can install its own. */
export function resetSubscribers(): void {
  SUBSCRIBERS.clear()
}

export function subscriberNames(): string[] {
  return [...SUBSCRIBERS.keys()]
}

export interface DrainResult {
  processed: number
  delivered: number
  failed: number
}

/**
 * Process pending events.
 *
 * Called after a mutation (through `next/server`'s `after`, so the user is not
 * made to wait for an email) and by the cron route, which is the safety net for
 * anything the in-request drain missed.
 *
 * `organizationId` narrows the sweep to one tenant. Unused in production, where
 * draining everything is correct, but it is what lets an integration suite
 * drain only its own events while other suites share the database.
 */
export async function drainOutbox({
  limit = 50,
  organizationId,
}: { limit?: number; organizationId?: string } = {}): Promise<DrainResult> {
  const db = getSystemDb()
  const result: DrainResult = { processed: 0, delivered: 0, failed: 0 }

  if (SUBSCRIBERS.size === 0) return result

  const events = await db.outboxEvent.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      attempts: { lt: MAX_ATTEMPTS },
      ...(organizationId ? { organizationId } : {}),
    },
    orderBy: { occurredAt: 'asc' },
    take: limit,
    select: {
      id: true,
      type: true,
      organizationId: true,
      entityType: true,
      entityId: true,
      actorId: true,
      occurredAt: true,
      payload: true,
      attempts: true,
    },
  })

  for (const row of events) {
    // An event type removed from the catalogue is not an error worth retrying.
    if (!isEventType(row.type)) {
      await db.outboxEvent.update({
        where: { id: row.id },
        data: { status: 'PROCESSED', processedAt: new Date(), lastError: 'Unknown event type' },
      })
      continue
    }

    const event: DomainEvent = {
      id: row.id,
      type: row.type,
      organizationId: row.organizationId,
      entityType: row.entityType,
      entityId: row.entityId,
      actorId: row.actorId,
      occurredAt: row.occurredAt,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    }

    const interested = [...SUBSCRIBERS.values()].filter(
      (subscriber) => !subscriber.types || subscriber.types.includes(event.type),
    )

    let anyFailed = false

    for (const subscriber of interested) {
      // Claiming the delivery row first is what makes this idempotent: a second
      // drain finds the row already present and skips the handler.
      const claimed = await claimDelivery(row.id, subscriber.name)
      if (!claimed) continue

      try {
        await subscriber.handle(event)
        await db.outboxDelivery.update({
          where: { eventId_subscriber: { eventId: row.id, subscriber: subscriber.name } },
          data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
        })
        result.delivered += 1
      } catch (error) {
        anyFailed = true
        result.failed += 1
        await db.outboxDelivery.update({
          where: { eventId_subscriber: { eventId: row.id, subscriber: subscriber.name } },
          data: {
            status: 'FAILED',
            lastError: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
          },
        })
        log.error('events.subscriber.failed', {
          subscriber: subscriber.name,
          type: event.type,
          error,
        })
      }
    }

    await db.outboxEvent.update({
      where: { id: row.id },
      data: {
        status: anyFailed ? 'FAILED' : 'PROCESSED',
        processedAt: anyFailed ? null : new Date(),
        attempts: { increment: 1 },
      },
    })

    result.processed += 1
  }

  return result
}

/**
 * Claim one delivery.
 *
 * Returns false when this subscriber has already handled the event — including
 * when it failed and is being retried, in which case the existing PENDING row
 * is reused rather than duplicated.
 */
async function claimDelivery(eventId: string, subscriber: string): Promise<boolean> {
  const db = getSystemDb()

  const existing = await db.outboxDelivery.findUnique({
    where: { eventId_subscriber: { eventId, subscriber } },
    select: { status: true, attempts: true },
  })

  if (existing?.status === 'DELIVERED') return false
  if (existing && existing.attempts >= MAX_ATTEMPTS) return false

  await db.outboxDelivery.upsert({
    where: { eventId_subscriber: { eventId, subscriber } },
    create: { eventId, subscriber, status: 'PENDING', attempts: 1 },
    update: { status: 'PENDING', attempts: { increment: 1 } },
  })

  return true
}
