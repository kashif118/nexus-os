import type { Metadata } from 'next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import {
  InviteMemberForm,
  MemberActions,
  MemberStatusBadge,
  RevokeInvitationButton,
} from '@/modules/organizations/components/members-panel'
import { MemberRoles } from '@/modules/organizations/components/role-controls'
import {
  listAssignableRoles,
  listMembers,
  listMembershipRoles,
  listPendingInvitations,
} from '@/modules/organizations/queries'

export const metadata: Metadata = { title: 'Members' }

export default async function MembersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  // Permission checks drive what is even fetched, not just what is rendered.
  const canManageRoles = ctx.can('organization.roles.manage')
  const canInvite = ctx.can('organization.members.invite')
  const canRemove = ctx.can('organization.members.remove')

  const [members, invitations, membershipRoles, assignableRoles] = await Promise.all([
    listMembers(ctx),
    canInvite ? listPendingInvitations(ctx) : Promise.resolve([]),
    listMembershipRoles(ctx),
    canManageRoles ? listAssignableRoles(ctx) : Promise.resolve([]),
  ])

  const rolesByMembership = new Map<string, Array<{ id: string; key: string; name: string }>>()
  for (const assignment of membershipRoles) {
    const list = rolesByMembership.get(assignment.membershipId) ?? []
    list.push(assignment.role)
    rolesByMembership.set(assignment.membershipId, list)
  }

  const roleOptions = assignableRoles.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
  }))

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Members</h1>
        <p className="text-muted-foreground text-sm">
          People who can access {ctx.org.name}, and what each of them is allowed to do.
        </p>
      </header>

      {canInvite ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite someone</CardTitle>
            <CardDescription>
              They receive a link valid for 14 days, bound to this address, and join as an Employee.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InviteMemberForm orgSlug={orgSlug} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Current members ({members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-border divide-y text-sm">
            {members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-start justify-between gap-4 py-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="space-y-0.5">
                    <p className="truncate font-medium">{member.user.name}</p>
                    <p className="text-muted-foreground truncate text-xs">{member.user.email}</p>
                  </div>
                  <MemberRoles
                    orgSlug={orgSlug}
                    membershipId={member.id}
                    heldRoles={rolesByMembership.get(member.id) ?? []}
                    assignableRoles={roleOptions}
                    canManage={canManageRoles}
                  />
                </div>

                <div className="flex items-center gap-3">
                  <MemberStatusBadge status={member.status} />
                  {canRemove ? (
                    <MemberActions
                      orgSlug={orgSlug}
                      member={{
                        id: member.id,
                        status: member.status,
                        title: member.title,
                        user: member.user,
                      }}
                      isSelf={member.userId === ctx.userId}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {canInvite && invitations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations ({invitations.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <p className="font-medium">{invitation.email}</p>
                    <p className="text-muted-foreground text-xs">
                      Expires {invitation.expiresAt.toISOString().slice(0, 10)}
                    </p>
                  </div>
                  <RevokeInvitationButton orgSlug={orgSlug} invitationId={invitation.id} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
