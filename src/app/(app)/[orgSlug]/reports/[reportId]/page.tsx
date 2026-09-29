import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { DeleteReportButton, PrintButton } from '@/modules/reports/components/report-forms'
import { generate } from '@/modules/reports/queries'

export const metadata: Metadata = { title: 'Report' }

/**
 * A generated report.
 *
 * Re-run on every view with the viewer's own context, so what is on screen is
 * both current and scoped to them. The print stylesheet is what makes "save as
 * PDF" produce something worth keeping — the browser's own engine, rather than
 * a bundled PDF library that would do it worse.
 */
export default async function ReportPage({
  params,
}: {
  params: Promise<{ orgSlug: string; reportId: string }>
}) {
  const { orgSlug, reportId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let report: Awaited<ReturnType<typeof generate>>
  try {
    report = await generate(ctx, reportId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div className="print:hidden">
        <PageHeader
          title={report.title}
          description={report.subtitle}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <PrintButton />
              {ctx.can('report.export') ? (
                <a
                  href={`/api/orgs/${orgSlug}/reports/${reportId}/export`}
                  className={buttonVariants({ size: 'sm', variant: 'outline' })}
                >
                  Download CSV
                </a>
              ) : null}
              {ctx.can('report.generate') ? (
                <DeleteReportButton orgSlug={orgSlug} reportId={reportId} />
              ) : null}
            </div>
          }
        />
        <Link
          href={`/${orgSlug}/reports`}
          className="text-muted-foreground mt-2 inline-block text-sm hover:underline"
        >
          ← All reports
        </Link>
      </div>

      {/* Shown only when printing, where the header above is hidden. */}
      <header className="hidden print:block">
        <h1 className="text-xl font-semibold">{report.title}</h1>
        <p className="text-sm">{report.subtitle}</p>
      </header>

      {report.sections.map((section) => (
        <Card key={section.title} className="print:border-0 print:shadow-none">
          <CardHeader>
            <CardTitle className="text-base">{section.title}</CardTitle>
            {section.note ? <CardDescription>{section.note}</CardDescription> : null}
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {section.rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing in this section.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    {section.columns.map((column) => (
                      <th
                        key={column.key}
                        className={`pb-2 font-medium ${column.align === 'right' ? 'text-right' : ''}`}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, index) => (
                    <tr key={index} className="border-b last:border-0">
                      {section.columns.map((column) => (
                        <td
                          key={column.key}
                          className={`py-2 ${column.align === 'right' ? 'tabular text-right' : ''}`}
                        >
                          {row[column.key] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      ))}

      <p className="text-muted-foreground text-xs">
        Generated {report.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC, from your
        own records, with your permissions.
      </p>
    </div>
  )
}
