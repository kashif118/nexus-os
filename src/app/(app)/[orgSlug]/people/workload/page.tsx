import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { WorkloadTable } from '@/modules/people/components/people-ui'
import { getWorkload } from '@/modules/people/queries'

export const metadata: Metadata = { title: 'Workload' }

export default async function WorkloadPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  let workload: Awaited<ReturnType<typeof getWorkload>>
  try {
    workload = await getWorkload(ctx)
  } catch (error) {
    if (isAppError(error) && error.code === 'FORBIDDEN') notFound()
    throw error
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Team workload"
        description="Estimated open work against weekly capacity."
      />
      <Card>
        <CardContent className="pt-5">
          <WorkloadTable
            orgSlug={orgSlug}
            rows={workload.rows}
            unestimatedTasks={workload.unestimatedTasks}
          />
        </CardContent>
      </Card>
    </div>
  )
}
