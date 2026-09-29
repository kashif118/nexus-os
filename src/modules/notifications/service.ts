import { EVENT_CATALOGUE, EVENT_GROUPS, EVENT_TYPES, isEventType } from '@/kernel/events'
import { validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'

import { resolveChannels } from './delivery'
import * as repository from './repository'

/**
 * Notifications are personal.
 *
 * There is no permission check in this file, and that is deliberate rather than
 * an omission: every query is keyed by `ctx.membershipId`, so the only rows a
 * caller can reach are their own. A "read anyone's notifications" permission
 * would be a feature nobody asked for and an audit finding waiting to happen.
 */

export async function listNotifications(
  ctx: Ctx,
  options: { unreadOnly?: boolean; limit?: number; cursor?: string } = {},
) {
  return repository.listNotifications(ctx, options)
}

export async function countUnread(ctx: Ctx): Promise<number> {
  return repository.countUnread(ctx)
}

export async function markRead(ctx: Ctx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  // Bounded so one request cannot ask the database to update an unbounded set.
  return repository.markRead(ctx, ids.slice(0, 200))
}

export async function markAllRead(ctx: Ctx): Promise<number> {
  return repository.markAllRead(ctx)
}

/* ------------------------------ preferences ------------------------------- */

export interface PreferenceRow {
  eventType: string
  label: string
  group: string
  inApp: boolean
  email: boolean
  digest: boolean
  /** True when no row is stored and the defaults are in force. */
  isDefault: boolean
}

/**
 * The preferences screen, generated from the event catalogue.
 *
 * Every event type appears with its current setting, whether or not a row has
 * been stored — so a new event type is visible and adjustable the moment it is
 * declared, instead of only after someone happens to change it.
 */
export async function listPreferences(ctx: Ctx): Promise<PreferenceRow[]> {
  const stored = await repository.listPreferences(ctx)

  return EVENT_TYPES.map((eventType) => {
    const definition = EVENT_CATALOGUE[eventType]
    const channels = resolveChannels(eventType, stored)

    return {
      eventType,
      label: definition.label,
      group: definition.group,
      inApp: channels.inApp,
      email: channels.email,
      digest: channels.digest,
      isDefault: !stored.some((row) => row.eventType === eventType),
    }
  })
}

export const preferenceGroups = () => [...EVENT_GROUPS]

export async function updatePreference(
  ctx: Ctx,
  input: { eventType: string; inApp: boolean; email: boolean; digest: boolean },
): Promise<void> {
  // The event type comes from a form, so it is checked against the catalogue
  // rather than stored as whatever arrived.
  if (!isEventType(input.eventType)) {
    throw validationError('That notification type does not exist.')
  }

  await repository.upsertPreference(ctx, input)
}

/* -------------------------------- activity -------------------------------- */

export async function listActivity(
  ctx: Ctx,
  filters: { entityType?: string | undefined; entityId?: string | undefined; limit?: number } = {},
) {
  return repository.listActivity(ctx, filters)
}
