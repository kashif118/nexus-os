import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatMoney } from '@/lib/money'
import {
  HealthBadge,
  MilestonesPanel,
  ProgressBar,
  ProjectForm,
  ProjectMembersPanel,
} from '@/modules/projects/components/project-ui'
import { getProject, getProjectFormOptions } from '@/modules/projects/queries'

export const metadata: Metadata = { title: 'Project' }

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>
}) {
  const { orgSlug, projectId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let project: Awaited<ReturnType<typeof getProject>>
  try {
    project = await getProject(ctx, projectId)
  } catch (error) {
    // A project in another tenant — or one this actor may not see — is 404, not
    // 403: a 403 would confirm it exists.
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const options = await getProjectFormOptions(ctx)
  const canEdit = ctx.can('project.update.any') || project.managerMembershipId === ctx.membershipId
  const canSeeBudget = ctx.can('project.budget.view')

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title={project.name}
        description={
          [project.company?.name, project.manager?.user.name].filter(Boolean).join(' · ') ||
          undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{project.key}</Badge>
            <HealthBadge status={project.healthStatus} score={project.healthScore} />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {/* Health explains itself: an indicator nobody understands gets ignored. */}
          <Card>
            <CardHeader>
              <CardTitle>Health</CardTitle>
              <CardDescription>
                Derived from deadlines, milestones and budget, recomputed on every change.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ProgressBar percent={project.progressPercent} />
              {project.assessment.signals.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing is pulling this project off track.
                </p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {project.assessment.signals.map((signal) => (
                    <li key={signal.label} className="flex items-center justify-between gap-3">
                      <span>{signal.label}</span>
                      <span className="text-destructive tabular text-xs">−{signal.penalty}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {canEdit ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <ProjectForm
                  orgSlug={orgSlug}
                  options={options}
                  currency={ctx.org.currency}
                  canSetBudget={ctx.can('project.budget.manage')}
                  project={project}
                />
              </CardContent>
            </Card>
          ) : project.description ? (
            <Card>
              <CardHeader>
                <CardTitle>About</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{project.description}</p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Milestones</CardTitle>
            </CardHeader>
            <CardContent>
              <MilestonesPanel
                orgSlug={orgSlug}
                projectId={project.id}
                milestones={project.milestones}
                canCreate={ctx.can('milestone.create')}
                canUpdate={ctx.can('milestone.update')}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Status" value={titleCase(project.status)} />
              <Row label="Priority" value={titleCase(project.priority)} />
              <Row label="Visibility" value={titleCase(project.visibility)} />
              {project.startDate ? (
                <Row label="Started" value={project.startDate.toISOString().slice(0, 10)} />
              ) : null}
              {project.dueDate ? (
                <Row label="Due" value={project.dueDate.toISOString().slice(0, 10)} />
              ) : null}
              {canSeeBudget && project.budgetMinor !== null ? (
                <Row label="Budget" value={formatMoney(project.budgetMinor, project.currency)} />
              ) : null}
              {project.company ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Client</span>
                  <Link
                    href={`/${orgSlug}/crm/companies/${project.company.id}`}
                    className="font-medium hover:underline"
                  >
                    {project.company.name}
                  </Link>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Team ({project.members.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ProjectMembersPanel
                orgSlug={orgSlug}
                projectId={project.id}
                members={project.members}
                options={options}
                canManage={ctx.can('project.member.manage')}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
