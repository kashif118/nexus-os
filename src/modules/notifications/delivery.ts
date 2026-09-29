import { EVENT_CATALOGUE, type EventType } from '@/kernel/events'

/**
 * How one event becomes zero or more notifications — pure, so the rules can be
 * tested without a database or a request.
 *
 * Two rules that are easy to get wrong and expensive when you do:
 *
 * 1. **Never notify the actor about their own action.** Nothing makes a
 *    notification centre feel more broken than being told what you just did.
 * 2. **Never notify the same person twice for one event.** A person who is both
 *    the assignee and a mentioned participant gets one notification, not two.
 */

export interface StoredPreference {
  eventType: string
  inApp: boolean
  email: boolean
  digest: boolean
}

export interface Channels {
  inApp: boolean
  email: boolean
  digest: boolean
}

/**
 * Resolve the channels for one recipient and event type.
 *
 * An absent row means "the default for this event type" rather than "off": a
 * member who has never opened their settings should still be told things.
 */
export function resolveChannels(
  type: EventType,
  preferences: ReadonlyArray<StoredPreference>,
): Channels {
  const stored = preferences.find((preference) => preference.eventType === type)
  const definition = EVENT_CATALOGUE[type]

  if (!stored) {
    return { inApp: definition.defaultInApp, email: definition.defaultEmail, digest: false }
  }

  return { inApp: stored.inApp, email: stored.email, digest: stored.digest }
}

export interface Recipient {
  membershipId: string
  /** Included only so the email channel has somewhere to send. */
  email: string
  name: string
  preferences: ReadonlyArray<StoredPreference>
}

export interface PlannedNotification {
  membershipId: string
  email: string
  name: string
  channels: Channels
}

/**
 * Decide who actually gets told.
 *
 * `actorMembershipId` is excluded, duplicates are collapsed, and anyone whose
 * preferences turn every channel off is dropped entirely rather than having a
 * row written that nothing will ever show.
 */
export function planDelivery(
  type: EventType,
  recipients: ReadonlyArray<Recipient>,
  actorMembershipId: string | null,
): PlannedNotification[] {
  const seen = new Set<string>()
  const planned: PlannedNotification[] = []

  for (const recipient of recipients) {
    if (recipient.membershipId === actorMembershipId) continue
    if (seen.has(recipient.membershipId)) continue
    seen.add(recipient.membershipId)

    const channels = resolveChannels(type, recipient.preferences)
    if (!channels.inApp && !channels.email && !channels.digest) continue

    planned.push({
      membershipId: recipient.membershipId,
      email: recipient.email,
      name: recipient.name,
      channels,
    })
  }

  return planned
}

/** The channel names recorded on the notification row. */
export function channelLabels(channels: Channels): string[] {
  const labels: string[] = []
  if (channels.inApp) labels.push('IN_APP')
  if (channels.email) labels.push('EMAIL')
  if (channels.digest) labels.push('DIGEST')
  return labels
}
