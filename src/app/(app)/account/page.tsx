import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'

import { ThemeToggle } from '@/components/theme-toggle'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { requireUserPage } from '@/kernel/auth/guards'
import { listActiveSessions } from '@/kernel/auth/session'
import {
  ResendVerificationButton,
  RevokeOtherSessionsButton,
  RevokeSessionButton,
  SignOutButton,
} from '@/modules/auth/components/account-actions'
import { getAccountOverview } from '@/modules/auth/queries'

export const metadata: Metadata = { title: 'Account' }

/**
 * Account and security page.
 *
 * This is the seed of the Security Center (docs/OPERATIONS.md §N.2): active
 * sessions with revocation, and recent sign-in history. All of it is real data
 * from the current user's own rows — nothing is placeholder.
 *
 * Profile editing, MFA enrolment and the organization switcher belong to later
 * phases and are deliberately absent rather than stubbed.
 */
export default async function AccountPage() {
  const session = await requireUserPage('/account')
  const [{ loginEvents }, sessions] = await Promise.all([
    getAccountOverview(session.user.id),
    listActiveSessions(session.user.id, session.sessionId),
  ])

  const verified = session.user.emailVerifiedAt !== null
  const otherSessions = sessions.filter((item) => !item.current)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Account</h1>
          <p className="text-muted-foreground text-sm">
            Signed in as <span className="text-foreground">{session.user.email}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>

      <Separator />

      {!verified ? (
        <Alert variant="warning" className="space-y-3">
          <p>
            Your email address is not confirmed yet. Check your inbox for the confirmation link.
          </p>
          <ResendVerificationButton />
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your identity across every organization you join.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Name" value={session.user.name} />
          <Row label="Email" value={session.user.email} />
          <Row
            label="Email status"
            value={
              verified ? (
                <Badge variant="success">Confirmed</Badge>
              ) : (
                <Badge variant="warning">Unconfirmed</Badge>
              )
            }
          />
          <Row
            label="Account status"
            value={<Badge variant="neutral">{session.user.status}</Badge>}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Every device currently signed in. Revoking takes effect on the next request — sessions
            are checked in the database, not carried in a token.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-border divide-y text-sm">
            {sessions.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {describeUserAgent(item.userAgent)}
                    </span>
                    {item.current ? <Badge variant="success">This device</Badge> : null}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {item.ip ?? 'Unknown address'} · last active{' '}
                    <time dateTime={item.lastSeenAt.toISOString()}>
                      {formatDateTime(item.lastSeenAt)}
                    </time>
                  </p>
                </div>
                {item.current ? null : <RevokeSessionButton sessionId={item.id} />}
              </li>
            ))}
          </ul>

          {otherSessions.length > 0 ? <RevokeOtherSessionsButton /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent sign-in activity</CardTitle>
          <CardDescription>
            Successful and failed attempts on your account, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loginEvents.length === 0 ? (
            <p className="text-muted-foreground text-sm">No activity recorded yet.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {loginEvents.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-4 py-2.5">
                  <div className="space-y-0.5">
                    <Badge variant={event.success ? 'success' : 'destructive'}>
                      {event.success ? 'Signed in' : (event.reason ?? 'Failed')}
                    </Badge>
                    <p className="text-muted-foreground text-xs">{event.ip ?? 'Unknown address'}</p>
                  </div>
                  <time
                    dateTime={event.createdAt.toISOString()}
                    className="text-muted-foreground tabular text-xs"
                  >
                    {formatDateTime(event.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Organizations, roles and permissions arrive in the next phases — see{' '}
        <Link href="/" className="underline underline-offset-4">
          the build status page
        </Link>
        .
      </p>
    </main>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

/** Coarse device label. A full UA parser is not worth a dependency here. */
function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'

  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : /Firefox\//.test(userAgent)
            ? 'Firefox'
            : 'Browser'

  const platform = /Windows/.test(userAgent)
    ? 'Windows'
    : /Macintosh|Mac OS/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Unknown OS'

  return `${browser} on ${platform}`
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(value)
}
