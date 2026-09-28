import { ALL_PERMISSIONS, type Permission } from './catalogue'

/**
 * The seven system roles (docs/PLATFORM.md §I.3).
 *
 * These are templates shared by every organization and are immutable: an
 * organization may clone one and adjust the copy, but cannot edit or delete the
 * original. Seeding them from code keeps the matrix reviewable in one place
 * rather than spread across a migration.
 *
 * `deny` exists because DENY beats every ALLOW. It is how the Client role is
 * expressed: broad read access to its own company, with an explicit denial of
 * everything internal.
 */

export const SYSTEM_ROLE_KEYS = [
  'owner',
  'admin',
  'manager',
  'employee',
  'finance_manager',
  'hr_manager',
  'client',
] as const

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number]

export interface SystemRoleDefinition {
  key: SystemRoleKey
  name: string
  description: string
  priority: number
  /** Granted permissions. `'*'` means the entire catalogue. */
  allow: Permission[] | '*'
  /** Denials, applied after allows and always winning. */
  deny?: Permission[]
}

/** Permissions shared by every internal role. */
const BASELINE: Permission[] = [
  'organization.read',
  'project.read.member',
  'task.read',
  'task.create',
  'task.comment',
  'task.update.own',
  'document.read.scoped',
  'document.upload',
  'analytics.view.own',
  'ai.use',
]

const MANAGER_PERMISSIONS: Permission[] = [
  ...BASELINE,
  'project.create',
  'project.read.any',
  'project.update.any',
  'project.archive',
  'project.member.manage',
  'project.budget.view',
  'milestone.create',
  'milestone.update',
  'milestone.delete',
  'task.update.any',
  'task.assign',
  'task.delete',
  'crm.lead.create',
  'crm.lead.read',
  'crm.lead.update',
  'crm.lead.convert',
  'crm.contact.create',
  'crm.contact.read',
  'crm.contact.update',
  'crm.company.create',
  'crm.company.read',
  'crm.company.update',
  'crm.deal.create',
  'crm.deal.read',
  'crm.deal.update',
  'crm.deal.stage.move',
  'crm.deal.value.view',
  'people.read',
  'people.workload.view',
  'document.read.any',
  'document.update',
  'document.share',
  'document.folder.manage',
  'finance.invoice.read',
  'finance.budget.read',
  'finance.expense.create',
  'finance.expense.read.own',
  'workflow.read',
  'workflow.run',
  'analytics.view.team',
  'report.generate',
  'report.view',
  'ai.agent.project',
  'ai.agent.crm',
  'ai.agent.reporting',
  'ai.agent.meeting',
]

const FINANCE_PERMISSIONS: Permission[] = [
  ...BASELINE,
  'project.read.any',
  'project.budget.view',
  'project.budget.manage',
  'crm.company.read',
  'crm.contact.read',
  'crm.deal.read',
  'crm.deal.value.view',
  'finance.invoice.create',
  'finance.invoice.read',
  'finance.invoice.update',
  'finance.invoice.delete',
  'finance.invoice.send',
  'finance.invoice.approve',
  'finance.invoice.void',
  'finance.invoice.payment.record',
  'finance.expense.create',
  'finance.expense.read.any',
  'finance.expense.read.own',
  'finance.expense.update',
  'finance.expense.approve',
  'finance.expense.reject',
  'finance.budget.read',
  'finance.budget.manage',
  'finance.report.view',
  'finance.report.export',
  'document.read.any',
  'analytics.view.org',
  'analytics.export',
  'report.generate',
  'report.view',
  'report.export',
  'workflow.read',
  'workflow.approve',
  'ai.agent.finance',
  'ai.agent.reporting',
]

const HR_PERMISSIONS: Permission[] = [
  ...BASELINE,
  'project.read.any',
  'people.read',
  'people.profile.read.sensitive',
  'people.profile.manage',
  'people.team.manage',
  'people.department.manage',
  'people.skill.manage',
  'people.workload.view',
  'document.read.any',
  'analytics.view.team',
  'report.generate',
  'report.view',
  'organization.members.invite',
]

/** Everything an Admin may do: the whole catalogue minus the owner-only keys. */
const OWNER_ONLY: Permission[] = ['organization.delete', 'organization.billing.manage']

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control, including billing and deleting the organization.',
    priority: 100,
    allow: '*',
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Everything except billing and deleting the organization.',
    priority: 90,
    allow: ALL_PERMISSIONS.filter((key) => !OWNER_ONLY.includes(key)),
    deny: OWNER_ONLY,
  },
  {
    key: 'manager',
    name: 'Manager',
    description:
      'Runs delivery: full projects, tasks, CRM and documents, team analytics, read-only finance.',
    priority: 70,
    allow: MANAGER_PERMISSIONS,
  },
  {
    key: 'finance_manager',
    name: 'Finance Manager',
    description: 'Owns invoicing, expenses and budgets, with read-only project and CRM context.',
    priority: 60,
    allow: FINANCE_PERMISSIONS,
  },
  {
    key: 'hr_manager',
    name: 'HR Manager',
    description: 'Owns people, teams, departments and skills, including sensitive profile fields.',
    priority: 60,
    allow: HR_PERMISSIONS,
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Works on assigned projects and tasks. No finance, people or settings access.',
    priority: 30,
    allow: [...BASELINE, 'finance.expense.create', 'finance.expense.read.own', 'people.read'],
  },
  {
    key: 'client',
    name: 'Client',
    description:
      'External access, limited to their own company: project status, shared documents and their invoices.',
    priority: 10,
    allow: ['organization.read', 'project.read.member', 'document.read.scoped', 'task.comment'],
    // Explicit denials, because DENY beats any ALLOW a future role edit might
    // add. An external party must never reach internal money or people data.
    deny: [
      'finance.invoice.create',
      'finance.invoice.update',
      'finance.expense.read.any',
      'finance.report.view',
      'people.read',
      'people.profile.read.sensitive',
      'analytics.view.org',
      'analytics.view.team',
      'audit.read',
      'workflow.create',
      'organization.members.invite',
      'organization.roles.manage',
    ],
  },
]

export const getSystemRole = (key: SystemRoleKey): SystemRoleDefinition => {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === key)
  if (!role) throw new Error(`Unknown system role: ${key}`)
  return role
}

/** Resolve a definition to concrete allow/deny sets. */
export function resolveRolePermissions(role: SystemRoleDefinition): {
  allow: Permission[]
  deny: Permission[]
} {
  return {
    allow: role.allow === '*' ? [...ALL_PERMISSIONS] : [...role.allow],
    deny: [...(role.deny ?? [])],
  }
}
