import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { ApprovalControls } from '@/modules/workflows/components/workflow-controls'
import { getRun } from '@/modules/workflows/queries'

export const metadata: Metadata = { title: 'Workflow run' }

const stepTone = (status: string) =>
  status === 'SUCCEEDED'
    ? 'success'
    : status === 'FAILED'
      ? 'destructive'
      : status === 'WAITING'
        ? 'warning'
        : 'neutral'

/**
 * The run inspector.
 *
 * Every step is a row with its input, output, error and duration. This is the
 * difference between an automation people trust and one they turn off: when a
 * workflow does something surprising, the answer to "why" has to be on a page,
 * not in a log file somebody has to be granted access to.
 */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; runId: string }>
}) {
  const { orgSlug, runId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let run: Awaited<ReturnType<typeof getRun>>
  try {
    run = await getRun(ctx, runId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        title={run.workflow.name}
        description={
          <>
            Triggered by {run.triggerType} · version {run.version.version} ·{' '}
            {run.startedAt.toISOString().replace('T', ' ').slice(0, 19)}
          </>
        }
        actions={
          <Badge variant={stepTone(run.status)}>
            {run.status.charAt(0) + run.status.slice(1).toLowerCase()}
          </Badge>
        }
      />

      <Link
        href={`/${orgSlug}/workflows/${run.workflow.id}`}
        className="text-muted-foreground text-sm hover:underline"
      >
        ← Back to the workflow
      </Link>

      {run.error ? (
        <Card>
          <CardHeader>
            <CardTitle>Why it stopped</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-destructive text-sm">{run.error}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Steps</CardTitle>
          <CardDescription>
            One row per node, in the order they ran. A skipped step means a condition was false —
            that is a normal outcome, not a failure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="divide-border divide-y text-sm">
            {run.steps.map((step) => (
              <li key={step.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <code className="font-mono text-xs">{step.nodeId}</code>
                    <span className="text-muted-foreground text-xs">
                      {step.kind ?? step.nodeType}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {step.durationMs !== null ? (
                      <span className="text-muted-foreground text-xs">{step.durationMs} ms</span>
                    ) : null}
                    <Badge variant={stepTone(step.status)}>
                      {step.status.charAt(0) + step.status.slice(1).toLowerCase()}
                    </Badge>
                  </span>
                </div>

                {step.error ? <p className="text-destructive text-xs">{step.error}</p> : null}

                {step.output && Object.keys(step.output as object).length > 0 ? (
                  <pre className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs">
                    {JSON.stringify(step.output, null, 2)}
                  </pre>
                ) : null}

                {step.status === 'WAITING' && step.nodeType === 'approval' ? (
                  <div className="pt-1">
                    {ctx.can('workflow.approve') ? (
                      <ApprovalControls orgSlug={orgSlug} stepId={step.id} />
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        Waiting for someone who can decide approvals.
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {run.context && Object.keys(run.context as object).length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Run data</CardTitle>
            <CardDescription>
              The trigger fields plus whatever each action added, in the order it was added.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
              {JSON.stringify(run.context, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
