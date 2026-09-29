import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { relativeTime } from '@/lib/format'
import {
  RunWorkflowForm,
  WorkflowStatusControls,
} from '@/modules/workflows/components/workflow-controls'
import { WorkflowEditor } from '@/modules/workflows/components/workflow-editor'
import {
  availableActions,
  availableTriggers,
  getWorkflow,
  listRuns,
} from '@/modules/workflows/queries'

export const metadata: Metadata = { title: 'Workflow' }

export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workflowId: string }>
}) {
  const { orgSlug, workflowId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let workflow: Awaited<ReturnType<typeof getWorkflow>>
  try {
    workflow = await getWorkflow(ctx, workflowId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const runs = await listRuns(ctx, workflowId)
  const triggers = availableTriggers()
  const actions = availableActions()

  const trigger = triggers.find((candidate) => candidate.type === workflow.triggerType)

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title={workflow.name}
        description={workflow.description ?? `Runs when: ${workflow.triggerType}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant={
                workflow.status === 'ACTIVE'
                  ? 'success'
                  : workflow.status === 'PAUSED'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {workflow.status.charAt(0) + workflow.status.slice(1).toLowerCase()}
            </Badge>
            {workflow.published ? (
              <span className="text-muted-foreground text-xs">
                Published v{workflow.published.version}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">Never published</span>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Definition</CardTitle>
              <CardDescription>
                Validated against the trigger and action registries. A condition may only read
                fields the trigger publishes, and an action may only do what the publisher is
                allowed to do.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {ctx.can('workflow.update') ? (
                <WorkflowEditor
                  orgSlug={orgSlug}
                  workflowId={workflow.id}
                  graph={workflow.draftGraph}
                  triggers={triggers}
                  actions={actions}
                  issues={workflow.validation.issues.map((issue) =>
                    issue.nodeId ? `${issue.nodeId}: ${issue.message}` : issue.message,
                  )}
                  canPublish={workflow.validation.valid}
                />
              ) : (
                <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
                  {JSON.stringify(workflow.draftGraph, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing has run yet. Publish it, or use a test run to see what it would do.
                </p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {runs.map((run) => (
                    <li key={run.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <Link
                          href={`/${orgSlug}/workflows/runs/${run.id}`}
                          className="font-medium hover:underline"
                        >
                          {run.triggerType}
                        </Link>
                        <p className="text-muted-foreground truncate text-xs">
                          {relativeTime(run.startedAt)} · {run._count.steps} step
                          {run._count.steps === 1 ? '' : 's'}
                          {run.error ? ` · ${run.error}` : ''}
                        </p>
                      </div>
                      <Badge
                        variant={
                          run.status === 'SUCCEEDED'
                            ? 'success'
                            : run.status === 'FAILED'
                              ? 'destructive'
                              : 'neutral'
                        }
                      >
                        {run.status.charAt(0) + run.status.slice(1).toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {ctx.can('workflow.update') ? (
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
              </CardHeader>
              <CardContent>
                <WorkflowStatusControls
                  orgSlug={orgSlug}
                  workflowId={workflow.id}
                  status={workflow.status}
                  canDelete={ctx.can('workflow.delete')}
                />
              </CardContent>
            </Card>
          ) : null}

          {ctx.can('workflow.run') ? (
            <Card>
              <CardHeader>
                <CardTitle>Test it</CardTitle>
                <CardDescription>
                  A test run performs nothing: each action reports what it would have done.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RunWorkflowForm
                  orgSlug={orgSlug}
                  workflowId={workflow.id}
                  sampleFields={trigger?.fields.map((field) => field.path) ?? []}
                />
              </CardContent>
            </Card>
          ) : null}

          {trigger ? (
            <Card>
              <CardHeader>
                <CardTitle>Trigger</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="font-medium">{trigger.label}</p>
                <p className="text-muted-foreground text-xs">{trigger.description}</p>
                <div>
                  <p className="text-xs font-medium">Fields a condition may read</p>
                  <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                    {trigger.fields.map((field) => (
                      <li key={field.path}>
                        <code className="font-mono">{field.path}</code> — {field.label}
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
