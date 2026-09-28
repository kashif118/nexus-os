import type { Metadata } from 'next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { listMembers } from '@/modules/organizations/queries'

export const metadata: Metadata = { title: 'Command Center' }

/**
 * Organization home.
 *
 * A placeholder for the Executive Command Center, which is built in Phase 06
 * against real project, task and finance data. It shows only what genuinely
 * exists today — the organization and its members — rather than mock KPIs.
 */
export default async function OrgHomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  const members = await listMembers(ctx)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{ctx.org.name}</h1>
        <p className="text-muted-foreground text-sm">
          The Executive Command Center is built in Phase 06 from real project, task and finance
          data. Until those modules exist there is nothing honest to chart here.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>People with access to this organization.</CardDescription>
          </CardHeader>
          <CardContent className="tabular text-3xl font-semibold">{members.length}</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>Regional defaults for formatting and reporting.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <span className="text-muted-foreground">Currency:</span> {ctx.org.currency}
            </p>
            <p>
              <span className="text-muted-foreground">Time zone:</span> {ctx.org.timezone}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
