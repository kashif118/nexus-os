'use client'

import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import {
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  setMemberStatusAction,
  type FormState,
} from '../actions'

export interface MemberRow {
  id: string
  status: string
  title: string | null
  user: { id: string; name: string; email: string }
}

export interface InvitationRow {
  id: string
  email: string
  expiresAt: Date
}

export function InviteMemberForm({ orgSlug }: { orgSlug: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(
    inviteMemberAction.bind(null, orgSlug),
    null,
  )

  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field
          name="email"
          label="Email address"
          type="email"
          required
          className="min-w-56 flex-1"
          errors={fields?.email}
        />
        <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
      </div>
    </form>
  )
}

export function MemberActions({
  orgSlug,
  member,
  isSelf,
}: {
  orgSlug: string
  member: MemberRow
  isSelf: boolean
}) {
  const suspend = setMemberStatusAction.bind(null, orgSlug, 'SUSPENDED')
  const reinstate = setMemberStatusAction.bind(null, orgSlug, 'ACTIVE')

  const [suspendState, suspendAction] = useActionState<FormState, FormData>(suspend, null)
  const [reinstateState, reinstateAction] = useActionState<FormState, FormData>(reinstate, null)
  const [removeState, removeAction] = useActionState<FormState, FormData>(
    removeMemberAction.bind(null, orgSlug),
    null,
  )

  if (isSelf) {
    return <span className="text-muted-foreground text-xs">You</span>
  }

  const error = [suspendState, reinstateState, removeState].find((state) => state && !state.ok) as
    Extract<FormState, { ok: false }> | undefined

  return (
    <div className="flex items-center gap-1">
      {error ? <span className="text-destructive mr-2 text-xs">{error.error.message}</span> : null}

      <form action={member.status === 'ACTIVE' ? suspendAction : reinstateAction}>
        <input type="hidden" name="membershipId" value={member.id} />
        <Button type="submit" variant="ghost" size="sm">
          {member.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}
        </Button>
      </form>

      <form action={removeAction}>
        <input type="hidden" name="membershipId" value={member.id} />
        <Button type="submit" variant="ghost" size="sm" className="text-destructive">
          Remove
        </Button>
      </form>
    </div>
  )
}

export function RevokeInvitationButton({
  orgSlug,
  invitationId,
}: {
  orgSlug: string
  invitationId: string
}) {
  const [, formAction] = useActionState<FormState, FormData>(
    revokeInvitationAction.bind(null, orgSlug),
    null,
  )

  return (
    <form action={formAction}>
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" variant="ghost" size="sm">
        Revoke
      </Button>
    </form>
  )
}

export function MemberStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={status === 'ACTIVE' ? 'success' : 'warning'}>
      {status === 'ACTIVE' ? 'Active' : 'Suspended'}
    </Badge>
  )
}
