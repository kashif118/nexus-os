import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EmptyState, PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { relativeTime } from '@/lib/format'
import { CreateReportForm } from '@/modules/reports/components/report-forms'
import { availableTemplates, listReports } from '@/modules/reports/queries'

export const metadata: Metadata = { title: 'Reports' }

export default async function ReportsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('report.view')) notFound()

  const reports = await listReports(ctx)
  const templates = availableTemplates(ctx)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="Reports"
        description="A saved report is its settings, not its numbers. Opening one re-runs it against current data."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Saved</CardTitle>
            </CardHeader>
            <CardContent>
              {reports.length === 0 ? (
                <EmptyState
                  title="No saved reports"
                  description="Save one and it is re-run whenever you open it, always against current data."
                />
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {reports.map((report) => (
                    <li key={report.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <Link
                          href={`/${orgSlug}/reports/${report.id}`}
                          className="font-medium hover:underline"
                        >
                          {report.name}
                        </Link>
                        <p className="text-muted-foreground truncate text-xs">
                          {report.templateName}
                          {report.lastRunAt
                            ? ` · last run ${relativeTime(report.lastRunAt)}`
                            : ' · never run automatically'}
                        </p>
                        {report.lastError ? (
                          <p className="text-destructive text-xs">
                            Last scheduled run failed: {report.lastError}
                          </p>
                        ) : null}
                      </div>
                      {report.schedule ? <Badge variant="neutral">{report.schedule}</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {ctx.can('report.generate') && templates.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>New report</CardTitle>
              <CardDescription>
                You only see reports you have access to the underlying data for.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateReportForm
                orgSlug={orgSlug}
                templates={templates}
                canSchedule={ctx.can('report.schedule')}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
