import { describe, expect, it } from 'vitest'

import {
  can,
  canAll,
  canAny,
  createPermissionSet,
  grantedFrom,
  require as requirePermission,
  resolveScope,
} from '../can'
import { ALL_PERMISSIONS, isPermission, splitPermission } from '../catalogue'
import { resolveRolePermissions, SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from '../roles'

/**
 * Authorization decisions, tested exhaustively.
 *
 * These are pure functions, so every role in the matrix can be checked against
 * every permission in the catalogue without a database — which is the only way
 * a 109-permission × 7-role matrix stays honest as it grows.
 */

const setFor = (roleKey: (typeof SYSTEM_ROLE_KEYS)[number]) => {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!
  const { allow, deny } = resolveRolePermissions(role)
  return createPermissionSet({ allowed: allow, denied: deny })
}

describe('permission catalogue', () => {
  it('declares every key in module.action form', () => {
    for (const key of ALL_PERMISSIONS) {
      const { module, action } = splitPermission(key)
      expect(module).not.toBe('')
      expect(action).not.toBe('')
      expect(key).toMatch(/^[a-z]+(\.[a-z_]+)+$/)
    }
  })

  it('has no duplicates', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length)
  })

  it('recognises only catalogued keys', () => {
    expect(isPermission('organization.read')).toBe(true)
    expect(isPermission('organization.reed')).toBe(false)
    expect(isPermission('')).toBe(false)
  })
})

describe('evaluation order', () => {
  it('denies by default', () => {
    const permissions = createPermissionSet({ allowed: [] })
    expect(can(permissions, 'project.create')).toBe(false)
  })

  it('allows what was granted', () => {
    const permissions = createPermissionSet({ allowed: ['project.create'] })
    expect(can(permissions, 'project.create')).toBe(true)
  })

  it('lets DENY beat ALLOW', () => {
    const permissions = createPermissionSet({
      allowed: ['finance.report.view'],
      denied: ['finance.report.view'],
    })
    expect(can(permissions, 'finance.report.view')).toBe(false)
  })

  it('lets DENY beat even the owner short-circuit', () => {
    // Deliberate: a denial is a statement that this actor must not do this, and
    // nothing may quietly undo it.
    const permissions = createPermissionSet({
      allowed: [],
      denied: ['organization.delete'],
      isOwner: true,
    })
    expect(can(permissions, 'organization.delete')).toBe(false)
  })

  it('grants an owner everything not explicitly denied', () => {
    const permissions = createPermissionSet({ allowed: [], isOwner: true })
    for (const key of ALL_PERMISSIONS) {
      expect(can(permissions, key)).toBe(true)
    }
  })
})

describe('require', () => {
  it('passes silently when held', () => {
    const permissions = createPermissionSet({ allowed: ['task.create'] })
    expect(() => requirePermission(permissions, 'task.create')).not.toThrow()
  })

  it('throws when not held', () => {
    const permissions = createPermissionSet({ allowed: [] })
    expect(() => requirePermission(permissions, 'task.create')).toThrow(/permission/i)
  })

  it('does not leak the permission key in the message', () => {
    const permissions = createPermissionSet({ allowed: [] })
    try {
      requirePermission(permissions, 'finance.invoice.approve')
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain('finance.invoice.approve')
    }
  })
})

describe('canAny and canAll', () => {
  const permissions = createPermissionSet({ allowed: ['task.update.own'] })

  it('canAny is true when one is held', () => {
    expect(canAny(permissions, ['task.update.any', 'task.update.own'])).toBe(true)
  })

  it('canAny is false when none are held', () => {
    expect(canAny(permissions, ['task.delete', 'task.assign'])).toBe(false)
  })

  it('canAll requires all', () => {
    expect(canAll(permissions, ['task.update.own'])).toBe(true)
    expect(canAll(permissions, ['task.update.own', 'task.delete'])).toBe(false)
  })
})

describe('resolveScope', () => {
  it('returns all when the broad permission is held', () => {
    const permissions = createPermissionSet({ allowed: ['task.update.any', 'task.update.own'] })
    expect(resolveScope(permissions, 'task.update.any', 'task.update.own')).toBe('all')
  })

  it('returns own when only the narrow permission is held', () => {
    const permissions = createPermissionSet({ allowed: ['task.update.own'] })
    expect(resolveScope(permissions, 'task.update.any', 'task.update.own')).toBe('own')
  })

  it('returns none when neither is held', () => {
    const permissions = createPermissionSet({ allowed: [] })
    expect(resolveScope(permissions, 'task.update.any', 'task.update.own')).toBe('none')
  })
})

describe('grantedFrom', () => {
  it('returns only the held subset, for the client snapshot', () => {
    const permissions = createPermissionSet({ allowed: ['task.create', 'task.read'] })
    expect(grantedFrom(permissions, ['task.create', 'task.delete', 'task.read'])).toEqual([
      'task.create',
      'task.read',
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* The role matrix (docs/PLATFORM.md §I.3)                                     */
/* -------------------------------------------------------------------------- */

describe('system roles', () => {
  it('defines all seven', () => {
    expect(SYSTEM_ROLES.map((role) => role.key).sort()).toEqual([...SYSTEM_ROLE_KEYS].sort())
  })

  it('references only catalogued permissions', () => {
    for (const role of SYSTEM_ROLES) {
      const { allow, deny } = resolveRolePermissions(role)
      for (const key of [...allow, ...deny]) {
        expect(isPermission(key), `${role.key} references unknown permission ${key}`).toBe(true)
      }
    }
  })

  it('gives Owner the whole catalogue', () => {
    const owner = setFor('owner')
    for (const key of ALL_PERMISSIONS) expect(can(owner, key)).toBe(true)
  })

  it('withholds billing and deletion from Admin', () => {
    const admin = setFor('admin')
    expect(can(admin, 'organization.delete')).toBe(false)
    expect(can(admin, 'organization.billing.manage')).toBe(false)
    expect(can(admin, 'organization.roles.manage')).toBe(true)
    expect(can(admin, 'project.create')).toBe(true)
  })

  it('gives Manager delivery control but not finance write access', () => {
    const manager = setFor('manager')
    expect(can(manager, 'project.create')).toBe(true)
    expect(can(manager, 'task.assign')).toBe(true)
    expect(can(manager, 'crm.deal.update')).toBe(true)
    expect(can(manager, 'finance.invoice.read')).toBe(true)
    expect(can(manager, 'finance.invoice.create')).toBe(false)
    expect(can(manager, 'finance.invoice.approve')).toBe(false)
    expect(can(manager, 'organization.roles.manage')).toBe(false)
  })

  it('gives Finance Manager money control but not delivery control', () => {
    const finance = setFor('finance_manager')
    expect(can(finance, 'finance.invoice.approve')).toBe(true)
    expect(can(finance, 'finance.expense.approve')).toBe(true)
    expect(can(finance, 'finance.budget.manage')).toBe(true)
    expect(can(finance, 'project.read.any')).toBe(true)
    expect(can(finance, 'project.create')).toBe(false)
    expect(can(finance, 'people.profile.read.sensitive')).toBe(false)
  })

  it('gives HR Manager sensitive people access and nothing financial', () => {
    const hr = setFor('hr_manager')
    expect(can(hr, 'people.profile.read.sensitive')).toBe(true)
    expect(can(hr, 'people.team.manage')).toBe(true)
    expect(can(hr, 'finance.invoice.read')).toBe(false)
    expect(can(hr, 'finance.report.view')).toBe(false)
  })

  it('limits Employee to their own work', () => {
    const employee = setFor('employee')
    expect(can(employee, 'task.create')).toBe(true)
    expect(can(employee, 'task.update.own')).toBe(true)
    expect(can(employee, 'finance.expense.create')).toBe(true)
    expect(can(employee, 'finance.expense.read.own')).toBe(true)

    expect(can(employee, 'task.update.any')).toBe(false)
    expect(can(employee, 'task.delete')).toBe(false)
    expect(can(employee, 'project.create')).toBe(false)
    expect(can(employee, 'project.read.any')).toBe(false)
    expect(can(employee, 'finance.expense.read.any')).toBe(false)
    expect(can(employee, 'finance.invoice.read')).toBe(false)
    expect(can(employee, 'people.profile.read.sensitive')).toBe(false)
    expect(can(employee, 'organization.update')).toBe(false)
    expect(can(employee, 'audit.read')).toBe(false)
  })

  it('keeps the external Client out of everything internal', () => {
    const client = setFor('client')

    expect(can(client, 'organization.read')).toBe(true)
    expect(can(client, 'project.read.member')).toBe(true)
    expect(can(client, 'document.read.scoped')).toBe(true)

    // The denials are the security property: an external party must never reach
    // internal money, people or audit data.
    expect(can(client, 'people.read')).toBe(false)
    expect(can(client, 'people.profile.read.sensitive')).toBe(false)
    expect(can(client, 'finance.report.view')).toBe(false)
    expect(can(client, 'finance.expense.read.any')).toBe(false)
    expect(can(client, 'analytics.view.org')).toBe(false)
    expect(can(client, 'analytics.view.team')).toBe(false)
    expect(can(client, 'audit.read')).toBe(false)
    expect(can(client, 'workflow.create')).toBe(false)
    expect(can(client, 'organization.roles.manage')).toBe(false)
    expect(can(client, 'organization.members.invite')).toBe(false)
  })

  it('grants no role outside Owner and Admin the ability to delete the organization', () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      if (key === 'owner') continue
      expect(can(setFor(key), 'organization.delete'), `${key} can delete the organization`).toBe(
        false,
      )
    }
  })

  it('grants no role outside Owner the ability to manage billing', () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      if (key === 'owner') continue
      expect(can(setFor(key), 'organization.billing.manage'), `${key} can manage billing`).toBe(
        false,
      )
    }
  })

  it('restricts role management to Owner and Admin', () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      const expected = key === 'owner' || key === 'admin'
      expect(can(setFor(key), 'organization.roles.manage'), `${key}`).toBe(expected)
    }
  })

  it('restricts the audit log to Owner and Admin', () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      const expected = key === 'owner' || key === 'admin'
      expect(can(setFor(key), 'audit.read'), `${key}`).toBe(expected)
    }
  })
})
