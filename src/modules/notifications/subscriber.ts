import { registerSubscriber, type DomainEvent, type Subscriber } from '@/kernel/events'
import { clientEnv } from '@/kernel/config/env'
import { getMailer } from '@/lib/email/mailer'

import { audienceFor } from './audience'
import { channelLabels, planDelivery } from './delivery'
import { renderEmail, renderNotification } from './render'
import * as repository from './repository'

/**
 * The notification subscriber.
 *
 * Runs outside a request, from committed events, so it has no `Ctx`. It takes
 * the organization from the event — which was written inside that
 * organization's own transaction — and never from anything a client supplied.
 *
 * A failure here marks this subscriber's delivery FAILED and leaves the others
 * alone; the dispatcher retries it up to five times and then stops rather than
 * looping on a poison event.
 */
/**
 * Exported as a value, not only registered.
 *
 * A module registers itself on import, and an ES module is imported once — so a
 * test that clears the registry cannot get the subscriber back by importing
 * again. Exporting the object means a test can re-register it explicitly, which
 * is what stops a suite from silently asserting the absence of a notification
 * that was never wired up.
 */
export const notificationSubscriber: Subscriber = {
  name: 'notifications',

  async handle(event: DomainEvent) {
    const orgSlug = await repository.organizationSlug(event.organizationId)
    if (!orgSlug) return

    const rendered = renderNotification(event, orgSlug)
    if (!rendered) return

    const membershipIds = await audienceFor(event)
    if (membershipIds.length === 0) return

    const recipients = await repository.recipientsByMembershipIds(
      event.organizationId,
      membershipIds,
    )

    // The actor is identified by user id on the event but by membership id
    // here, so it is resolved once rather than compared across two identities.
    const actorMembershipId = actorMembershipIdOf(event)

    const planned = planDelivery(event.type, recipients, actorMembershipId)
    if (planned.length === 0) return

    const inApp = planned.filter((entry) => entry.channels.inApp)

    await repository.createNotifications(
      inApp.map((entry) => ({
        organizationId: event.organizationId,
        recipientMembershipId: entry.membershipId,
        type: event.type,
        title: rendered.title,
        body: rendered.body ?? null,
        href: rendered.href ?? null,
        entityType: event.entityType,
        entityId: event.entityId,
        actorId: event.actorId,
        priority: rendered.priority,
        channels: channelLabels(entry.channels),
      })),
    )

    // Email is sent one at a time and failures are swallowed per recipient: one
    // bad address must not cost everyone else their notification.
    for (const entry of planned.filter((candidate) => candidate.channels.email)) {
      const message = renderEmail(rendered, entry.name, clientEnv.NEXT_PUBLIC_APP_URL)
      try {
        await getMailer().send({
          to: entry.email,
          subject: message.subject,
          text: message.text,
        })
      } catch (error) {
        console.error('[notifications] email failed', { to: entry.email, error })
      }
    }
  },
}

registerSubscriber(notificationSubscriber)

/**
 * Map the acting user to their membership in this organization.
 *
 * Returns null when the actor is not among the recipients, which is the common
 * case — and harmless, since the only use is to exclude them.
 */
function actorMembershipIdOf(event: DomainEvent): string | null {
  const fromPayload = event.payload.actorMembershipId
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : null
}
