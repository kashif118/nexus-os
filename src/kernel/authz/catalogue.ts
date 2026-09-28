/**
 * The permission catalogue (docs/PLATFORM.md §I.2).
 *
 * This file is the single source of truth. The database `Permission` table is
 * seeded FROM it, the `Permission` union type is derived FROM it, and a
 * migration test asserts the two agree. Nothing invents a permission string.
 *
 * Naming is `module.action[.scope]`. A `.any` / `.own` pair means the action is
 * ownership-sensitive: `task.update.own` covers your own work, `task.update.any`
 * covers everyone's.
 *
 * Keys for modules that do not exist yet are still declared here, because the
 * role matrix in §I.3 is defined in terms of them and seeding the full
 * catalogue once avoids a migration per phase. A permission nobody checks is
 * inert — it grants nothing until a service calls `require` with it.
 */

export const PERMISSION_CATALOGUE = {
  'organization.read': 'View the organization profile',
  'organization.update': 'Change organization settings',
  'organization.delete': 'Delete the organization',
  'organization.members.invite': 'Invite people to the organization',
  'organization.members.remove': 'Remove or suspend members',
  'organization.roles.manage': 'Create roles and change who holds them',
  'organization.billing.manage': 'Manage the subscription and billing details',
  'organization.apikey.manage': 'Create and revoke API keys',

  'project.create': 'Create projects',
  'project.read.any': 'View every project in the organization',
  'project.read.member': 'View projects you belong to',
  'project.update.any': 'Edit any project',
  'project.update.own': 'Edit projects you manage',
  'project.delete': 'Delete projects',
  'project.archive': 'Archive projects',
  'project.member.manage': 'Add and remove project members',
  'project.budget.view': 'See project budgets',
  'project.budget.manage': 'Set project budgets',

  'task.create': 'Create tasks',
  'task.read': 'View tasks',
  'task.update.any': 'Edit any task',
  'task.update.own': 'Edit tasks you created or are assigned',
  'task.delete': 'Delete tasks',
  'task.assign': 'Assign tasks to people',
  'task.comment': 'Comment on tasks',

  'milestone.create': 'Create milestones',
  'milestone.update': 'Edit milestones',
  'milestone.delete': 'Delete milestones',

  'crm.lead.create': 'Create leads',
  'crm.lead.read': 'View leads',
  'crm.lead.update': 'Edit leads',
  'crm.lead.delete': 'Delete leads',
  'crm.lead.convert': 'Convert leads into contacts and deals',
  'crm.contact.create': 'Create contacts',
  'crm.contact.read': 'View contacts',
  'crm.contact.update': 'Edit contacts',
  'crm.contact.delete': 'Delete contacts',
  'crm.company.create': 'Create companies',
  'crm.company.read': 'View companies',
  'crm.company.update': 'Edit companies',
  'crm.company.delete': 'Delete companies',
  'crm.deal.create': 'Create deals',
  'crm.deal.read': 'View deals',
  'crm.deal.update': 'Edit deals',
  'crm.deal.delete': 'Delete deals',
  'crm.deal.stage.move': 'Move deals between pipeline stages',
  'crm.deal.value.view': 'See deal values',

  'people.read': 'View people and teams',
  'people.profile.read.sensitive': 'See sensitive employee details such as pay rates',
  'people.profile.manage': 'Edit employee profiles',
  'people.team.manage': 'Create and change teams',
  'people.department.manage': 'Create and change departments',
  'people.skill.manage': 'Manage the skills catalogue',
  'people.workload.view': 'See team workload',

  'finance.invoice.create': 'Create invoices',
  'finance.invoice.read': 'View invoices',
  'finance.invoice.update': 'Edit invoices',
  'finance.invoice.delete': 'Delete draft invoices',
  'finance.invoice.send': 'Send invoices to clients',
  'finance.invoice.approve': 'Approve invoices for sending',
  'finance.invoice.void': 'Void issued invoices',
  'finance.invoice.payment.record': 'Record payments against invoices',
  'finance.expense.create': 'Submit expenses',
  'finance.expense.read.any': 'View every expense',
  'finance.expense.read.own': 'View your own expenses',
  'finance.expense.update': 'Edit expenses',
  'finance.expense.approve': 'Approve expenses',
  'finance.expense.reject': 'Reject expenses',
  'finance.budget.read': 'View budgets',
  'finance.budget.manage': 'Set budgets',
  'finance.report.view': 'View financial reports',
  'finance.report.export': 'Export financial reports',

  'document.upload': 'Upload documents',
  'document.read.any': 'View every document',
  'document.read.scoped': 'View documents shared with you',
  'document.update': 'Rename and move documents',
  'document.delete': 'Delete documents',
  'document.share': 'Share documents',
  'document.folder.manage': 'Create and change folders',

  'workflow.read': 'View workflows and their runs',
  'workflow.create': 'Create workflows',
  'workflow.update': 'Edit workflows',
  'workflow.delete': 'Delete workflows',
  'workflow.run': 'Run workflows manually',
  'workflow.approve': 'Decide workflow approval steps',

  'ai.use': 'Use the AI assistant',
  'ai.agent.executive': 'Use the Executive agent',
  'ai.agent.project': 'Use the Project agent',
  'ai.agent.finance': 'Use the Finance agent',
  'ai.agent.crm': 'Use the CRM agent',
  'ai.agent.research': 'Use the Research agent',
  'ai.agent.reporting': 'Use the Reporting agent',
  'ai.agent.meeting': 'Use the Meeting agent',
  'ai.settings.manage': 'Change AI settings for the organization',
  'ai.cost.view': 'See AI usage and cost',

  'analytics.view.org': 'See organization-wide analytics',
  'analytics.view.team': 'See analytics for your teams',
  'analytics.view.own': 'See your own analytics',
  'analytics.export': 'Export analytics',

  'report.generate': 'Generate reports',
  'report.schedule': 'Schedule recurring reports',
  'report.view': 'View generated reports',
  'report.export': 'Export reports',

  'audit.read': 'Read the audit log',
  'audit.export': 'Export the audit log',

  'security.session.view': 'See active sessions in the organization',
  'security.session.revoke': 'Revoke sessions',
  'security.loginhistory.view': 'See sign-in history',
  'security.alert.manage': 'Manage security alerts',
} as const

/**
 * The permission union.
 *
 * `ctx.require('projct.update')` is a compile error, which is the point of
 * deriving this rather than accepting `string` (docs/PLATFORM.md §I.2).
 */
export type Permission = keyof typeof PERMISSION_CATALOGUE

export const ALL_PERMISSIONS = Object.keys(PERMISSION_CATALOGUE) as Permission[]

export const isPermission = (value: string): value is Permission =>
  Object.prototype.hasOwnProperty.call(PERMISSION_CATALOGUE, value)

/** `finance.invoice.send` → module `finance`, action `invoice.send`. */
export function splitPermission(key: Permission): { module: string; action: string } {
  const [module, ...rest] = key.split('.')
  return { module: module ?? key, action: rest.join('.') || key }
}

export const describePermission = (key: Permission): string => PERMISSION_CATALOGUE[key]
