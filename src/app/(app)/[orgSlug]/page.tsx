import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'

import { CardSkeleton, PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { WidgetCard } from '@/modules/dashboard/components/widget-card'
import { getDashboard } from '@/modules/dashboard/queries'

export const metadata: Metadata = { title: 'Command Center' }

/**
 * The Executive Command Center.
 *
 * Renders the widget registry rather than a fixed set of cards: each module
 * contributes widgets as it is built, filtered by the actor permissions, and
 * every number comes from a real query against this organization.
 *
 * Widgets are streamed inside Suspense so a slow metric does not block the page.
 */
export default async function CommandCenterPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title={ctx.org.name}
        description="Everything that needs your attention, from live organization data."
      />

      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardGrid orgSlug={orgSlug} />
      </Suspense>
    </div>
  )
}

async function DashboardGrid({ orgSlug }: { orgSlug: string }) {
  const ctx = await requireCtxPage(orgSlug)
  const { widgets, pending } = await getDashboard(ctx)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-12 gap-4">
        {widgets.map((widget) => (
          <WidgetCard key={widget.definition.id} widget={widget} />
        ))}
      </div>

      {pending.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Coming as modules land</CardTitle>
            <CardDescription>
              The Command Center is a registry: each module contributes its own widgets, so these
              appear here automatically once the module exists. Nothing is shown before it can be
              answered from real data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {pending.map((entry) => (
                <li key={entry.module} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
                  <span className="min-w-28 font-medium">{entry.module}</span>
                  <span className="text-muted-foreground">{entry.contributes}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-4 text-xs">
              Build order is in{' '}
              <Link href="/" className="underline underline-offset-4">
                the project roadmap
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <CardSkeleton key={index} className="col-span-12 sm:col-span-6 lg:col-span-3" />
      ))}
    </div>
  )
}
