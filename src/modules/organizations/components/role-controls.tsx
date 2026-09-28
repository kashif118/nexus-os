'use client'

import { useActionState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { assignRoleAction, unassignRoleAction, type FormState } from '../actions'

export interface RoleOption {
  id: string
  key: string
  name: string
}

/**
 * Role assignment for one member.
 *
 * Rendered only for actors holding `organization.roles.manage`, but that is
 * cosmetic: the service re-checks the permission AND refuses to grant a role
 * carrying permissions the actor does not hold (docs/PLATFORM.md §I.5).
 */
export function MemberRoles({
  orgSlug,
  membershipId,
  heldRoles,
  assignableRoles,
  canManage,
}: {
  orgSlug: string
  membershipId: string
  heldRoles: RoleOption[]
  assignableRoles: RoleOption[]
  canManage: boolean
}) {
  const [assignState, assignAction] = useActionState<FormState, FormData>(
    assignRoleAction.bind(null, orgSlug),
    null,
  )
  const [removeState, removeAction] = useActionState<FormState, FormData>(
    unassignRoleAction.bind(null, orgSlug),
    null,
  )

  const heldIds = new Set(heldRoles.map((role) => role.id))
  const available = assignableRoles.filter((role) => !heldIds.has(role.id))
  const error = [assignState, removeState].find((state) => state && !state.ok) as
    Extract<FormState, { ok: false }> | undefined

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {heldRoles.length === 0 ? (
          <span className="text-muted-foreground text-xs">No role assigned</span>
        ) : (
          heldRoles.map((role) => (
            <span key={role.id} className="inline-flex items-center gap-1">
              <Badge variant={role.key === 'owner' ? 'default' : 'neutral'}>{role.name}</Badge>
              {canManage ? (
                <form action={removeAction}>
                  <input type="hidden" name="membershipId" value={membershipId} />
                  <input type="hidden" name="roleId" value={role.id} />
                  <button
                    type="submit"
                    className="text-muted-foreground hover:text-destructive text-xs"
                    aria-label={`Remove ${role.name} role`}
                  >
                    ×
                  </button>
                </form>
              ) : null}
            </span>
          ))
        )}
      </div>

      {canManage && available.length > 0 ? (
        <form action={assignAction} className="flex items-center gap-2">
          <input type="hidden" name="membershipId" value={membershipId} />
          <label className="sr-only" htmlFor={`role-${membershipId}`}>
            Add role
          </label>
          <select
            id={`role-${membershipId}`}
            name="roleId"
            defaultValue=""
            className="border-input bg-background h-7 rounded-md border px-2 text-xs"
          >
            <option value="" disabled>
              Add role…
            </option>
            {available.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" size="sm">
            Add
          </Button>
        </form>
      ) : null}

      {error ? <p className="text-destructive text-xs">{error.error.message}</p> : null}
    </div>
  )
}
