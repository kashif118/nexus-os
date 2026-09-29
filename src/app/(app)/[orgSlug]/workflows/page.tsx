import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EmptyState, PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { relativeTime } from '@/lib/format'
import {
  ApprovalControls,
  CreateWorkflowForm,
} from '@/modules/workflows/components/workflow-controls'
import {
  availableTriggers,
  listPendingApprovals,
  listRuns,
  listWorkflows,
} from '@/modules/workflows/queries'

export const metadata: Metadata = { title: 'Workflows' }

const statusTone = (status: string) =>
  status === 'ACTIVE'
    ? 'success'
    : status === 'PAUSED'
      ? 'warning'
      : status === 'ARCHIVED'
        ? 'destructive'
        : 'neutral'

const runTone = (status: string) =>
  status === 'SUCCEEDED'
    ? 'success'
    : status === 'FAILED'
      ? 'destructive'
      : status === 'WAITING'
        ? 'warning'
        : 'neutral'

export default async function WorkflowsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('workflow.read')) notFound()

  const [workflows, runs, approvals] = await Promise.all([
    listWorkflows(ctx),
    listRuns(ctx),
    listPendingApprovals(ctx),
  ])

  const triggers = availableTriggers()

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Workflows"
        description="Automations that run themselves when something happens. Each one acts with the permissions of the person who published it."
      />

      {approvals.length > 0 && ctx.can('workflow.approve') ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting on you</CardTitle>
            <CardDescription>
              These runs are suspended until somebody decides. Nothing downstream has happened yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {approvals.map((approval) => (
                <li
                  key={approval.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <Link
                      href={`/${orgSlug}/workflows/runs/${approval.runId}`}
                      className="font-medium hover:underline"
                    >
                      {approval.run.workflow.name}
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      Waiting since {relativeTime(approval.startedAt)}
                      {approval.approvalDeadline
                        ? ` · decides itself ${relativeTime(approval.approvalDeadline)}`
                        : ''}
                    </p>
                  </div>
                  <ApprovalControls orgSlug={orgSlug} stepId={approval.id} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Your workflows</CardTitle>
            </CardHeader>
            <CardContent>
              {workflows.length === 0 ? (
                <EmptyState
                  title="No workflows yet"
                  description="A workflow watches for something happening, checks a condition, and then acts."
                />
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {workflows.map((workflow) => (
                    <li key={workflow.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <Link
                          href={`/${orgSlug}/workflows/${workflow.id}`}
                          className="font-medium hover:underline"
                        >
                          {workflow.name}
                        </Link>
                        <p className="text-muted-foreground truncate text-xs">
                          Runs on {workflow.triggerType} · {workflow._count.runs} run
                          {workflow._count.runs === 1 ? '' : 's'}
                          {workflow.owner ? ` · owned by ${workflow.owner.user.name}` : ''}
                        </p>
                      </div>
                      <Badge variant={statusTone(workflow.status)}>
                        {workflow.status.charAt(0) + workflow.status.slice(1).toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent runs</CardTitle>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing has run yet.</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {runs.map((run) => (
                    <li key={run.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <Link
                          href={`/${orgSlug}/workflows/runs/${run.id}`}
                          className="font-medium hover:underline"
                        >
                          {run.workflow.name}
                        </Link>
                        <p className="text-muted-foreground truncate text-xs">
                          {run.triggerType} · v{run.version.version} · {run._count.steps} step
                          {run._count.steps === 1 ? '' : 's'} · {relativeTime(run.startedAt)}
                        </p>
                      </div>
                      <Badge variant={runTone(run.status)}>
                        {run.status.charAt(0) + run.status.slice(1).toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {ctx.can('workflow.create') ? (
          <Card>
            <CardHeader>
              <CardTitle>New workflow</CardTitle>
            </CardHeader>
            <CardContent>
              <CreateWorkflowForm orgSlug={orgSlug} triggers={triggers} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
