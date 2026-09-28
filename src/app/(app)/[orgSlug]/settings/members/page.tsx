import type { Metadata } from 'next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import {
  InviteMemberForm,
  MemberActions,
  MemberStatusBadge,
  RevokeInvitationButton,
} from '@/modules/organizations/components/members-panel'
import { listMembers, listPendingInvitations } from '@/modules/organizations/queries'

export const metadata: Metadata = { title: 'Members' }

export default async function MembersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const [members, invitations] = await Promise.all([listMembers(ctx), listPendingInvitations(ctx)])

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Members</h1>
        <p className="text-muted-foreground text-sm">
          People who can access {ctx.org.name}. Roles and granular permissions arrive in the next
          phase; today the organization owner manages membership.
        </p>
      </header>

      {ctx.isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite someone</CardTitle>
            <CardDescription>
              They receive a link valid for 14 days, bound to this address.
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
              <li key={member.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-medium">{member.user.name}</p>
                  <p className="text-muted-foreground truncate text-xs">{member.user.email}</p>
                </div>
                <div className="flex items-center gap-3">
                  <MemberStatusBadge status={member.status} />
                  {ctx.isOwner ? (
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

      {ctx.isOwner && invitations.length > 0 ? (
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
