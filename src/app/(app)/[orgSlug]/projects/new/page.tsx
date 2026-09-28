import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { ProjectForm } from '@/modules/projects/components/project-ui'
import { getProjectFormOptions } from '@/modules/projects/queries'

export const metadata: Metadata = { title: 'New project' }

export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('project.create')) notFound()

  const options = await getProjectFormOptions(ctx)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <PageHeader title="New project" />
      <Card>
        <CardContent className="pt-5">
          <ProjectForm
            orgSlug={orgSlug}
            options={options}
            currency={ctx.org.currency}
            canSetBudget={ctx.can('project.budget.manage')}
          />
        </CardContent>
      </Card>
    </div>
  )
}
