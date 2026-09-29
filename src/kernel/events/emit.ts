import { getSystemDb } from '@/lib/db'

import type { EventType } from './catalogue'

/**
 * Emit a domain event.
 *
 * The event row is the commitment. Nothing is notified, emailed or indexed
 * here — a subscriber runs later, reading committed rows, which is what makes
 * the whole thing safe to retry.
 *
 * `tx` accepts a transaction client so an event can be written in the SAME
 * transaction as the change it describes. That is the point of an outbox: if
 * the change rolls back, so does the event, and nobody is told about something
 * that did not happen.
 */
export interface EmitInput {
  type: EventType
  organizationId: string
  entityType: string
  entityId: string
  actorId?: string | null
  actorType?: string
  payload?: Record<string, unknown>
}

/** Minimal shape of the Prisma client surface this needs. */
interface OutboxWriter {
  outboxEvent: {
    create(args: { data: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }>
  }
}

export async function emitEvent(input: EmitInput, tx?: OutboxWriter): Promise<{ id: string }> {
  const client = (tx ?? getSystemDb()) as OutboxWriter

  return client.outboxEvent.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? 'USER',
      payload: (input.payload ?? {}) as never,
      status: 'PENDING',
    },
    select: { id: true },
  })
}

/**
 * Emit without letting a failure break the caller.
 *
 * Used where the event is genuinely secondary — an activity feed entry, say.
 * Anything a user is entitled to be told about should use `emitEvent` inside
 * the same transaction instead, so it cannot be silently lost.
 */
export async function emitEventSafely(input: EmitInput): Promise<void> {
  try {
    await emitEvent(input)
  } catch (error) {
    console.error('[events] failed to emit', { type: input.type, error })
  }
}
