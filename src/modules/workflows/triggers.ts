import type { FieldMap } from './conditions'
import { registerTrigger } from './registry'

/**
 * The built-in triggers.
 *
 * Each one declares exactly which fields a condition may read. That list is the
 * allowlist the interpreter enforces, so a workflow author cannot reach into
 * the payload for something the trigger did not intend to publish — and the
 * builder's field picker is generated from the same list, so what is offered
 * and what is permitted cannot drift apart.
 */

const str = (payload: Record<string, unknown>, key: string): string =>
  typeof payload[key] === 'string' ? (payload[key] as string) : ''

const num = (payload: Record<string, unknown>, key: string): number | undefined => {
  const value = payload[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

registerTrigger({
  type: 'task.assigned',
  label: 'A task is assigned',
  description: 'Runs when someone is assigned a task.',
  entityType: 'Task',
  eventTypes: ['task.assigned'],
  fields: [
    { path: 'title', label: 'Task title', type: 'string' },
    { path: 'assigneeMembershipId', label: 'Assignee', type: 'string' },
    { path: 'actorName', label: 'Assigned by', type: 'string' },
  ],
  toFields: (payload): FieldMap => ({
    title: str(payload, 'title'),
    assigneeMembershipId: str(payload, 'assigneeMembershipId'),
    actorName: str(payload, 'actorName'),
  }),
})

registerTrigger({
  type: 'expense.submitted',
  label: 'An expense is submitted',
  description: 'Runs when a claim is sent for approval.',
  entityType: 'Expense',
  eventTypes: ['expense.submitted'],
  fields: [
    { path: 'amountMinor', label: 'Amount (minor units)', type: 'money' },
    { path: 'amount', label: 'Amount (formatted)', type: 'string' },
    { path: 'actorName', label: 'Claimant', type: 'string' },
  ],
  toFields: (payload): FieldMap => ({
    amountMinor: num(payload, 'amountMinor'),
    amount: str(payload, 'amount'),
    actorName: str(payload, 'actorName'),
  }),
})

registerTrigger({
  type: 'invoice.overdue',
  label: 'An invoice becomes overdue',
  description: 'Runs when an issued invoice passes its due date unpaid.',
  entityType: 'Invoice',
  eventTypes: ['invoice.overdue'],
  fields: [
    { path: 'number', label: 'Invoice number', type: 'string' },
    { path: 'totalMinor', label: 'Total (minor units)', type: 'money' },
    { path: 'balanceMinor', label: 'Balance (minor units)', type: 'money' },
    { path: 'companyName', label: 'Client', type: 'string' },
    { path: 'dueDate', label: 'Due date', type: 'date' },
  ],
  toFields: (payload): FieldMap => ({
    number: str(payload, 'number'),
    totalMinor: num(payload, 'totalMinor'),
    balanceMinor: num(payload, 'balanceMinor'),
    companyName: str(payload, 'companyName'),
    dueDate: str(payload, 'dueDate'),
  }),
})

registerTrigger({
  type: 'invoice.paid',
  label: 'An invoice is paid',
  description: 'Runs when an invoice is settled in full.',
  entityType: 'Invoice',
  eventTypes: ['invoice.paid'],
  fields: [
    { path: 'number', label: 'Invoice number', type: 'string' },
    { path: 'amount', label: 'Amount (formatted)', type: 'string' },
  ],
  toFields: (payload): FieldMap => ({
    number: str(payload, 'number'),
    amount: str(payload, 'amount'),
  }),
})

registerTrigger({
  type: 'deal.won',
  label: 'A deal is won',
  description: 'Runs when a deal moves into a winning stage.',
  entityType: 'Deal',
  eventTypes: ['deal.won'],
  fields: [
    { path: 'title', label: 'Deal title', type: 'string' },
    { path: 'stageName', label: 'Stage', type: 'string' },
    { path: 'ownerMembershipId', label: 'Owner', type: 'string' },
  ],
  toFields: (payload): FieldMap => ({
    title: str(payload, 'title'),
    stageName: str(payload, 'stageName'),
    ownerMembershipId: str(payload, 'ownerMembershipId'),
  }),
})

registerTrigger({
  type: 'deal.stage.changed',
  label: 'A deal changes stage',
  description: 'Runs on every pipeline stage move.',
  entityType: 'Deal',
  eventTypes: ['deal.stage.changed'],
  fields: [
    { path: 'title', label: 'Deal title', type: 'string' },
    { path: 'stageName', label: 'New stage', type: 'string' },
    { path: 'ownerMembershipId', label: 'Owner', type: 'string' },
  ],
  toFields: (payload): FieldMap => ({
    title: str(payload, 'title'),
    stageName: str(payload, 'stageName'),
    ownerMembershipId: str(payload, 'ownerMembershipId'),
  }),
})

registerTrigger({
  type: 'document.shared',
  label: 'A document is shared',
  description: 'Runs when a document is shared with a person.',
  entityType: 'Document',
  eventTypes: ['document.shared'],
  fields: [
    { path: 'name', label: 'Document name', type: 'string' },
    { path: 'actorName', label: 'Shared by', type: 'string' },
  ],
  toFields: (payload): FieldMap => ({
    name: str(payload, 'name'),
    actorName: str(payload, 'actorName'),
  }),
})

registerTrigger({
  type: 'project.member.added',
  label: 'Someone joins a project',
  description: 'Runs when a member is added to a project.',
  entityType: 'Project',
  eventTypes: ['project.member.added'],
  fields: [
    { path: 'name', label: 'Project name', type: 'string' },
    { path: 'membershipId', label: 'Member', type: 'string' },
  ],
  toFields: (payload): FieldMap => ({
    name: str(payload, 'name'),
    membershipId: str(payload, 'membershipId'),
  }),
})
