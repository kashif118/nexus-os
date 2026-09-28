import { forbidden } from '@/kernel/errors'

import type { Permission } from './catalogue'

/**
 * Permission evaluation (docs/PLATFORM.md §I.1).
 *
 * A pure function over a resolved permission set, deliberately separated from
 * loading: it can be tested exhaustively with no database, and the loader can be
 * cached without complicating the decision.
 *
 * Evaluation order, and why:
 *
 *   1. DENY wins over everything. A denial is a deliberate statement that this
 *      actor must not do this, and no additive role may quietly undo it. This is
 *      what makes the external Client role safe.
 *   2. Owner short-circuits to ALLOW. An owner cannot lock themselves out of
 *      their own organization by editing roles.
 *   3. Otherwise an explicit ALLOW is required. The default is refusal, so a
 *      permission nobody granted is denied rather than accidentally open.
 */

export interface PermissionSet {
  /** Permissions explicitly granted by any of the actor roles. */
  readonly allowed: ReadonlySet<Permission>
  /** Permissions explicitly denied. Always beats `allowed`. */
  readonly denied: ReadonlySet<Permission>
  /** Owner short-circuit. */
  readonly isOwner: boolean
}

export function createPermissionSet(input: {
  allowed: Iterable<Permission>
  denied?: Iterable<Permission>
  isOwner?: boolean
}): PermissionSet {
  return {
    allowed: new Set(input.allowed),
    denied: new Set(input.denied ?? []),
    isOwner: input.isOwner ?? false,
  }
}

/** Does this actor hold `permission`? */
export function can(permissions: PermissionSet, permission: Permission): boolean {
  if (permissions.denied.has(permission)) return false
  if (permissions.isOwner) return true
  return permissions.allowed.has(permission)
}

/** Does this actor hold at least one of these? Useful for `.any` / `.own` pairs. */
export function canAny(permissions: PermissionSet, candidates: readonly Permission[]): boolean {
  return candidates.some((permission) => can(permissions, permission))
}

export function canAll(permissions: PermissionSet, candidates: readonly Permission[]): boolean {
  return candidates.every((permission) => can(permissions, permission))
}

/**
 * Assert a permission, throwing `ForbiddenError` otherwise.
 *
 * Services call this; the action wrapper maps the throw to a 403 result. The
 * message deliberately does not name the permission key — that is internal
 * vocabulary, and leaking it tells an attacker what to look for.
 */
export function require(permissions: PermissionSet, permission: Permission): void {
  if (!can(permissions, permission)) {
    throw forbidden('You do not have permission to do that.')
  }
}

export function requireAny(permissions: PermissionSet, candidates: readonly Permission[]): void {
  if (!canAny(permissions, candidates)) {
    throw forbidden('You do not have permission to do that.')
  }
}

/**
 * The subset of a candidate list this actor holds.
 *
 * Used to build the client permission snapshot, which drives whether a control
 * is rendered. Cosmetic only — every action re-checks server-side (§I.5).
 */
export function grantedFrom(
  permissions: PermissionSet,
  candidates: readonly Permission[],
): Permission[] {
  return candidates.filter((permission) => can(permissions, permission))
}

/**
 * Resolve an ownership-sensitive pair.
 *
 * `task.update.any` covers everyone; `task.update.own` covers only rows the
 * actor owns. Returning the decision as data — rather than a boolean — lets the
 * caller turn it into a query filter instead of fetching rows and discarding
 * them in JavaScript (§I.4).
 */
export type ScopeDecision = 'all' | 'own' | 'none'

export function resolveScope(
  permissions: PermissionSet,
  anyPermission: Permission,
  ownPermission: Permission,
): ScopeDecision {
  if (can(permissions, anyPermission)) return 'all'
  if (can(permissions, ownPermission)) return 'own'
  return 'none'
}
