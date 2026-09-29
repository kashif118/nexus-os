/**
 * The event catalogue.
 *
 * Every event a module can emit is declared here with the audience it is for
 * and the default delivery. Two reasons it is a single table rather than string
 * literals scattered across modules:
 *
 * 1. **The preferences screen is generated from it.** A member can only choose
 *    between notifications the system actually sends, and a new event type
 *    appears in their settings the moment it is declared.
 * 2. **A typo becomes a type error.** `EventType` is derived from these keys,
 *    so emitting `"task.assinged"` does not compile.
 *
 * `defaultEmail` is deliberately conservative. Email is interruption; the
 * default is in-app, and email is opt-in except where the event is a request
 * addressed to one person that blocks their colleague until they act.
 */

export const EVENT_CATALOGUE = {
  'task.assigned': {
    label: 'A task is assigned to you',
    group: 'Work',
    defaultInApp: true,
    defaultEmail: false,
  },
  'task.mentioned': {
    label: 'Someone mentions you in a comment',
    group: 'Work',
    defaultInApp: true,
    defaultEmail: true,
  },
  'task.commented': {
    label: 'Someone comments on a task assigned to you',
    group: 'Work',
    defaultInApp: true,
    defaultEmail: false,
  },
  'task.due.soon': {
    label: 'A task you own is nearly due',
    group: 'Work',
    defaultInApp: true,
    defaultEmail: false,
  },
  'project.member.added': {
    label: 'You are added to a project',
    group: 'Work',
    defaultInApp: true,
    defaultEmail: false,
  },
  'project.health.degraded': {
    label: 'A project you manage becomes at risk',
    group: 'Work',
    defaultInApp: true,
    defaultEmail: false,
  },
  'deal.stage.changed': {
    label: 'A deal you own moves stage',
    group: 'Sales',
    defaultInApp: true,
    defaultEmail: false,
  },
  'deal.won': {
    label: 'A deal you own is won',
    group: 'Sales',
    defaultInApp: true,
    defaultEmail: false,
  },
  'expense.submitted': {
    label: 'An expense needs your approval',
    group: 'Finance',
    defaultInApp: true,
    // Somebody is waiting on this decision, so it is worth an email.
    defaultEmail: true,
  },
  'expense.decided': {
    label: 'Your expense is approved or rejected',
    group: 'Finance',
    defaultInApp: true,
    defaultEmail: true,
  },
  'invoice.paid': {
    label: 'An invoice is paid in full',
    group: 'Finance',
    defaultInApp: true,
    defaultEmail: false,
  },
  'invoice.overdue': {
    label: 'An invoice becomes overdue',
    group: 'Finance',
    defaultInApp: true,
    defaultEmail: false,
  },
  'document.shared': {
    label: 'A document is shared with you',
    group: 'Documents',
    defaultInApp: true,
    defaultEmail: false,
  },
  'member.joined': {
    label: 'Someone joins the organization',
    group: 'Organization',
    defaultInApp: true,
    defaultEmail: false,
  },
} as const

export type EventType = keyof typeof EVENT_CATALOGUE

export const EVENT_TYPES = Object.keys(EVENT_CATALOGUE) as EventType[]

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOGUE, value)
}

export function eventDefinition(type: EventType) {
  return EVENT_CATALOGUE[type]
}

/** Event groups, in the order the preferences screen shows them. */
export const EVENT_GROUPS = ['Work', 'Sales', 'Finance', 'Documents', 'Organization'] as const
export type EventGroup = (typeof EVENT_GROUPS)[number]
