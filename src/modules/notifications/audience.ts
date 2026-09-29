import type { DomainEvent } from '@/kernel/events'

import * as repository from './repository'

/**
 * Who should hear about an event.
 *
 * The audience is computed from the event payload wherever possible, because
 * the payload is the state at the moment the thing happened. Where it must be
 * a query — "everyone who can approve expenses" — it is a permission lookup,
 * not a role name: roles are editable, and a deployment that renames
 * `finance_manager` should not silently stop routing approvals.
 */
export async function audienceFor(event: DomainEvent): Promise<string[]> {
  const payload = event.payload
  const ids = (key: string): string[] => {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return [value]
    if (Array.isArray(value))
      return value.filter((entry): entry is string => typeof entry === 'string')
    return []
  }

  switch (event.type) {
    case 'task.assigned':
      return ids('assigneeMembershipId')

    case 'task.mentioned':
      return ids('mentionedMembershipIds')

    case 'task.commented':
      return [...ids('assigneeMembershipId'), ...ids('watcherMembershipIds')]

    case 'task.due.soon':
      return ids('assigneeMembershipId')

    case 'project.member.added':
      return ids('membershipId')

    case 'project.health.degraded':
      return ids('managerMembershipId')

    case 'deal.stage.changed':
    case 'deal.won':
      return ids('ownerMembershipId')

    case 'expense.submitted':
      // Anyone who can approve, minus the claimant — `planDelivery` removes the
      // actor, and the service refuses self-approval regardless.
      return repository.membershipsWithPermission(event.organizationId, ['finance.expense.approve'])

    case 'expense.decided':
      return ids('submittedByMembershipId')

    case 'invoice.paid':
    case 'invoice.overdue':
      return repository.membershipsWithPermission(event.organizationId, ['finance.invoice.read'])

    case 'document.shared':
      return ids('subjectMembershipIds')

    case 'member.joined':
      return repository.membershipsWithPermission(event.organizationId, [
        'organization.members.invite',
      ])

    default:
      return []
  }
}
