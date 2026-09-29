import { describe, expect, it } from 'vitest'

import { can, createPermissionSet } from '../can'
import { ALL_PERMISSIONS, PERMISSION_CATALOGUE, type Permission } from '../catalogue'
import { SYSTEM_ROLES } from '../roles'

/**
 * The authorization matrix.
 *
 * Generated from the role definitions rather than written out, so it covers
 * every role against every permission — 7 × 109 — and a permission added in a
 * future phase is in the matrix the moment it is in the catalogue.
 *
 * It asserts four things that are easy to break and expensive to notice late:
 *
 * 1. Every permission a role grants exists in the catalogue. A typo in a role
 *    definition would otherwise be a silently missing permission.
 * 2. DENY beats ALLOW, including for an organization owner. That is the rule
 *    that makes a Client role safe to hand to an external party.
 * 3. Roles are strictly ordered where the product says they are: an Admin can
 *    do everything a Manager can, and so on down.
 * 4. No role accidentally holds a permission the product reserves.
 */

const permissionsFor = (roleKey: string) => {
  const role = SYSTEM_ROLES.find((entry) => entry.key === roleKey)
  if (!role) throw new Error(`No such role: ${roleKey}`)

  const allowed = new Set<Permission>(
    role.allow === '*' ? ALL_PERMISSIONS : (role.allow as Permission[]),
  )
  const denied = new Set<Permission>((role.deny ?? []) as Permission[])

  return createPermissionSet({ allowed, denied, isOwner: roleKey === 'owner' })
}

describe('the role definitions', () => {
  it('grant only permissions that exist in the catalogue', () => {
    for (const role of SYSTEM_ROLES) {
      if (role.allow === '*') continue

      for (const permission of role.allow) {
        expect(
          Object.hasOwn(PERMISSION_CATALOGUE, permission),
          `${role.key} grants "${permission}", which is not in the catalogue`,
        ).toBe(true)
      }
    }
  })

  it('deny only permissions that exist in the catalogue', () => {
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.deny ?? []) {
        expect(
          Object.hasOwn(PERMISSION_CATALOGUE, permission),
          `${role.key} denies "${permission}", which is not in the catalogue`,
        ).toBe(true)
      }
    }
  })

  it('give every role a distinct key and a priority', () => {
    const keys = SYSTEM_ROLES.map((role) => role.key)
    expect(new Set(keys).size).toBe(keys.length)

    for (const role of SYSTEM_ROLES) {
      expect(role.priority, `${role.key} has no priority`).toBeGreaterThan(0)
    }
  })
})

describe('the matrix', () => {
  const matrix = new Map(SYSTEM_ROLES.map((role) => [role.key, permissionsFor(role.key)]))

  it.each(SYSTEM_ROLES.map((role) => role.key))(
    '%s: every permission resolves to a definite answer',
    (roleKey) => {
      const permissions = matrix.get(roleKey)!

      for (const permission of ALL_PERMISSIONS) {
        // Not "is allowed" — that differs per role — but "answers at all".
        expect(typeof can(permissions, permission)).toBe('boolean')
      }
    },
  )

  it('gives the owner everything except what is explicitly denied', () => {
    const owner = matrix.get('owner')!

    for (const permission of ALL_PERMISSIONS) {
      expect(can(owner, permission), `owner cannot ${permission}`).toBe(true)
    }
  })

  it('gives an Admin everything except the owner-only permissions', () => {
    const admin = matrix.get('admin')!

    expect(can(admin, 'organization.delete')).toBe(false)
    expect(can(admin, 'organization.billing.manage')).toBe(false)

    // And genuinely everything else.
    const missing = ALL_PERMISSIONS.filter(
      (permission) =>
        !can(admin, permission) &&
        permission !== 'organization.delete' &&
        permission !== 'organization.billing.manage',
    )

    expect(missing, `admin is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('makes DENY beat ALLOW even for an owner', () => {
    // The rule the Client role depends on: an explicit denial cannot be
    // overridden by a broader grant, including the owner short-circuit.
    const permissions = createPermissionSet({
      allowed: new Set<Permission>(['finance.invoice.read']),
      denied: new Set<Permission>(['finance.invoice.read']),
      isOwner: true,
    })

    expect(can(permissions, 'finance.invoice.read')).toBe(false)
  })

  it('keeps an external Client away from internal money and people', () => {
    const client = matrix.get('client')!

    for (const permission of [
      'finance.invoice.read',
      'finance.report.view',
      'people.read',
      'people.profile.read.sensitive',
      'organization.members.invite',
      'security.loginhistory.view',
    ] as Permission[]) {
      expect(can(client, permission), `client should not have ${permission}`).toBe(false)
    }
  })

  it('orders Admin above Manager above Employee, with no exceptions', () => {
    const admin = matrix.get('admin')!
    const manager = matrix.get('manager')!
    const employee = matrix.get('employee')!

    const adminGaps = ALL_PERMISSIONS.filter(
      (permission) => can(manager, permission) && !can(admin, permission),
    )
    const managerGaps = ALL_PERMISSIONS.filter(
      (permission) => can(employee, permission) && !can(manager, permission),
    )

    expect(adminGaps, `manager can do what admin cannot: ${adminGaps.join(', ')}`).toEqual([])
    expect(managerGaps, `employee can do what manager cannot: ${managerGaps.join(', ')}`).toEqual(
      [],
    )
  })

  it('gives every role the baseline a member needs to use the product', () => {
    // A role that cannot read its own organization cannot render a page.
    for (const role of SYSTEM_ROLES) {
      const permissions = matrix.get(role.key)!
      expect(
        can(permissions, 'organization.read'),
        `${role.key} cannot read the organization`,
      ).toBe(true)
    }
  })

  it('reserves the destructive organization permissions to the owner alone', () => {
    for (const role of SYSTEM_ROLES) {
      if (role.key === 'owner') continue
      const permissions = matrix.get(role.key)!

      expect(
        can(permissions, 'organization.delete'),
        `${role.key} can delete the organization`,
      ).toBe(false)
    }
  })

  it('does not let a non-finance role approve expenses or void invoices', () => {
    for (const roleKey of ['employee', 'client', 'hr_manager'] as const) {
      const permissions = matrix.get(roleKey)!

      expect(can(permissions, 'finance.expense.approve'), roleKey).toBe(false)
      expect(can(permissions, 'finance.invoice.void'), roleKey).toBe(false)
    }
  })

  it('does not let a non-HR role read pay rates', () => {
    for (const roleKey of ['manager', 'employee', 'client', 'finance_manager'] as const) {
      const permissions = matrix.get(roleKey)!
      expect(can(permissions, 'people.profile.read.sensitive'), roleKey).toBe(false)
    }
  })
})

describe('the catalogue itself', () => {
  it('describes every permission it defines', () => {
    for (const permission of ALL_PERMISSIONS) {
      const description = PERMISSION_CATALOGUE[permission]
      expect(description, `${permission} has no description`).toBeTruthy()
      expect(description.length).toBeGreaterThan(5)
    }
  })

  it('uses a consistent dotted shape', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission, `${permission} is not dotted`).toMatch(/^[a-z]+(\.[a-z]+)+$/)
    }
  })

  it('has not shrunk unexpectedly', () => {
    // A guard against a refactor silently dropping permissions: the matrix
    // above would still pass over a much smaller catalogue.
    expect(ALL_PERMISSIONS.length).toBeGreaterThanOrEqual(100)
  })
})
