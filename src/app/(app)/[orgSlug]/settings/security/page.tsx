import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PERMISSION_CATALOGUE, type Permission } from '@/kernel/authz/catalogue'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { relativeTime } from '@/modules/notifications/components/notification-list'
import {
  CreateApiKeyForm,
  RevokeApiKeyButton,
  RevokeSessionButton,
  SecurityPolicyForm,
} from '@/modules/security/components/security-controls'
import {
  getPolicy,
  listApiKeys,
  listLoginEvents,
  listMySessions,
  listSessions,
} from '@/modules/security/queries'

export const metadata: Metadata = { title: 'Security' }

/** A user agent string, shortened to something a person can read. */
function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'

  const browser = /Firefox\/|Edg\/|Chrome\/|Safari\//.exec(userAgent)?.[0]?.replace('/', '') ?? ''
  const platform = /Windows|Macintosh|Linux|Android|iPhone|iPad/.exec(userAgent)?.[0] ?? ''

  return [browser, platform].filter(Boolean).join(' on ') || 'Unknown device'
}

export default async function SecurityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const canSeeSessions = ctx.can('security.session.view')
  const canSeeHistory = ctx.can('security.loginhistory.view')
  const canManageKeys = ctx.can('organization.apikey.manage')
  const canManagePolicy = ctx.can('organization.update')

  if (!canSeeSessions && !canSeeHistory && !canManageKeys && !canManagePolicy) notFound()

  const [mySessions, orgSessions, loginEvents, apiKeys, policy] = await Promise.all([
    listMySessions(ctx),
    canSeeSessions ? listSessions(ctx) : Promise.resolve([]),
    canSeeHistory ? listLoginEvents(ctx) : Promise.resolve([]),
    canManageKeys ? listApiKeys(ctx) : Promise.resolve([]),
    getPolicy(ctx),
  ])

  // Only permissions the viewer actually holds can be granted to a key.
  const grantableScopes = (Object.keys(PERMISSION_CATALOGUE) as Permission[])
    .filter((permission) => ctx.can(permission))
    .map((permission) => ({ key: permission, label: PERMISSION_CATALOGUE[permission] }))

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        title="Security"
        description="Who is signed in, what has happened, and what has access."
      />

      <Card>
        <CardHeader>
          <CardTitle>Your sessions</CardTitle>
          <CardDescription>
            Signing out of one ends it immediately — sessions are checked against the database on
            every request, not just at sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-border divide-y text-sm">
            {mySessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {describeAgent(session.userAgent)}
                    {session.id === ctx.sessionId ? (
                      <Badge variant="success" className="ml-2">
                        This one
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {session.ip ?? 'address unknown'} · last used {relativeTime(session.lastSeenAt)}
                  </p>
                </div>
                <RevokeSessionButton
                  orgSlug={orgSlug}
                  sessionId={session.id}
                  label={session.id === ctx.sessionId ? 'Sign out' : 'End'}
                />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {canSeeSessions ? (
        <Card>
          <CardHeader>
            <CardTitle>Everyone else</CardTitle>
            <CardDescription>
              Active sessions belonging to members of this organization.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {orgSessions.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nobody else is signed in.</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {orgSessions.map((session) => (
                  <li key={session.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{session.user.name}</p>
                      <p className="text-muted-foreground truncate text-xs">
                        {describeAgent(session.userAgent)} · {session.ip ?? 'address unknown'} ·{' '}
                        {relativeTime(session.lastSeenAt)}
                      </p>
                    </div>
                    {ctx.can('security.session.revoke') ? (
                      <RevokeSessionButton orgSlug={orgSlug} sessionId={session.id} label="End" />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {canSeeHistory ? (
        <Card>
          <CardHeader>
            <CardTitle>Sign-in history</CardTitle>
            <CardDescription>
              Failures are recorded too, including attempts against addresses that do not exist.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loginEvents.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {loginEvents.slice(0, 25).map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate">
                        {event.user?.name ?? event.email}{' '}
                        <Badge variant={event.success ? 'success' : 'destructive'}>
                          {event.success ? 'signed in' : (event.reason ?? 'failed')}
                        </Badge>
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {event.ip ?? 'address unknown'} · {describeAgent(event.userAgent)}
                      </p>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {relativeTime(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {canManageKeys ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>API keys</CardTitle>
              <CardDescription>
                A key reads through the same permissions its creator has. Stored only as a hash.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {apiKeys.length === 0 ? (
                <p className="text-muted-foreground text-sm">No keys.</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {apiKeys.map((key) => (
                    <li key={key.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{key.name}</p>
                        <p className="text-muted-foreground truncate text-xs">
                          <code className="font-mono">{key.prefix}…</code> · {key.scopes.length}{' '}
                          permission{key.scopes.length === 1 ? '' : 's'} ·{' '}
                          {key.lastUsedAt
                            ? `last used ${relativeTime(key.lastUsedAt)}`
                            : 'never used'}
                        </p>
                      </div>
                      <RevokeApiKeyButton orgSlug={orgSlug} keyId={key.id} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>New key</CardTitle>
            </CardHeader>
            <CardContent>
              <CreateApiKeyForm orgSlug={orgSlug} grantableScopes={grantableScopes} />
            </CardContent>
          </Card>
        </div>
      ) : null}

      {canManagePolicy ? (
        <Card>
          <CardHeader>
            <CardTitle>Organization settings</CardTitle>
          </CardHeader>
          <CardContent>
            <SecurityPolicyForm
              orgSlug={orgSlug}
              policy={{
                sessionIdleMinutes: policy.sessionIdleMinutes,
                allowedIpRanges: policy.allowedIpRanges,
                alertOnNewIp: policy.alertOnNewIp,
              }}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
