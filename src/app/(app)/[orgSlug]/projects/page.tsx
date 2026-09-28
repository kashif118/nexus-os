import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { buttonVariants } from '@/components/ui/button'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import { SearchInput } from '@/modules/crm/components/search-input'
import { ProjectTable } from '@/modules/projects/components/project-ui'
import { listProjects } from '@/modules/projects/queries'
import { PROJECT_SORT_FIELDS, PROJECT_STATUSES } from '@/modules/projects/schema'

export const metadata: Metadata = { title: 'Projects' }

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const resolved = await searchParams
  const listParams = parseListParams(resolved, {
    sortableFields: PROJECT_SORT_FIELDS,
    defaultSort: 'dueDate',
    defaultDirection: 'asc',
  })

  const requestedStatus = Array.isArray(resolved.status) ? resolved.status[0] : resolved.status
  const status = PROJECT_STATUSES.includes(requestedStatus as never) ? requestedStatus : undefined

  let page: Awaited<ReturnType<typeof listProjects>>
  try {
    page = await listProjects(ctx, listParams, { status })
  } catch (error) {
    // No project read permission at all: the route should not exist for them.
    if (isAppError(error) && error.code === 'FORBIDDEN') notFound()
    throw error
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <PageHeader
        title="Projects"
        description="Delivery work, its clients, its team and its health."
        actions={
          ctx.can('project.create') ? (
            <Link href={`/${orgSlug}/projects/new`} className={buttonVariants({ size: 'sm' })}>
              New project
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search projects…" />
        <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter by status">
          <Link
            href={`/${orgSlug}/projects`}
            className={`rounded-md px-2 py-1 ${!status ? 'bg-accent' : 'hover:bg-accent/60'}`}
          >
            All
          </Link>
          {PROJECT_STATUSES.map((value) => (
            <Link
              key={value}
              href={`/${orgSlug}/projects?status=${value}`}
              className={`rounded-md px-2 py-1 ${status === value ? 'bg-accent' : 'hover:bg-accent/60'}`}
            >
              {value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')}
            </Link>
          ))}
        </nav>
      </div>

      <ProjectTable
        orgSlug={orgSlug}
        rows={page.items}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
        sort={listParams.sort}
        canSeeBudget={ctx.can('project.budget.view')}
      />
    </div>
  )
}
