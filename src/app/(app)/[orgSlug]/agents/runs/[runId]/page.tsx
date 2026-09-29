import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { ProposalControls } from '@/modules/ai/agents/components/agent-controls'
import { getRun } from '@/modules/ai/agents/queries'

export const metadata: Metadata = { title: 'Agent run' }

/**
 * The transparency panel.
 *
 * Every tool the agent called, what it passed, what came back, and what it
 * proposed. This is what makes an agent supervisable rather than something a
 * team has to take on faith — and it is why every step is a row.
 */
export default async function AgentRunPage({
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
        title={run.agentKey}
        description={`Started ${run.startedAt.toISOString().replace('T', ' ').slice(0, 19)} · ${run.trigger}`}
        actions={
          <Badge
            variant={
              run.status === 'COMPLETED'
                ? 'success'
                : run.status === 'FAILED'
                  ? 'destructive'
                  : 'warning'
            }
          >
            {run.status.charAt(0) + run.status.slice(1).toLowerCase().replace(/_/g, ' ')}
          </Badge>
        }
      />

      <Link href={`/${orgSlug}/agents`} className="text-muted-foreground text-sm hover:underline">
        ← Back to agents
      </Link>

      {run.summary ? (
        <Card>
          <CardHeader>
            <CardTitle>What it reported</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{run.summary}</p>
          </CardContent>
        </Card>
      ) : null}

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

      {run.proposals.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Proposals</CardTitle>
            <CardDescription>
              A pending proposal has not happened. Accepting it carries it out with YOUR
              permissions, not the agent&rsquo;s.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-border divide-y">
            {run.proposals.map((proposal) =>
              proposal.status === 'PENDING' ? (
                <ProposalControls
                  key={proposal.id}
                  orgSlug={orgSlug}
                  proposalId={proposal.id}
                  summary={proposal.summary}
                  toolName={proposal.toolName}
                />
              ) : (
                <div key={proposal.id} className="flex items-center justify-between gap-3 py-2">
                  <p className="text-sm">{proposal.summary}</p>
                  <Badge
                    variant={
                      proposal.status === 'ACCEPTED'
                        ? 'success'
                        : proposal.status === 'REJECTED'
                          ? 'neutral'
                          : 'destructive'
                    }
                  >
                    {proposal.status.charAt(0) + proposal.status.slice(1).toLowerCase()}
                  </Badge>
                </div>
              ),
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>What it did</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="divide-border divide-y text-sm">
            {run.steps.map((step) => (
              <li key={step.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">{step.position}</span>
                    <Badge variant={step.kind === 'proposal' ? 'warning' : 'neutral'}>
                      {step.kind}
                    </Badge>
                    {step.toolName ? (
                      <code className="font-mono text-xs">{step.toolName}</code>
                    ) : null}
                  </span>
                  {step.durationMs !== null ? (
                    <span className="text-muted-foreground text-xs">{step.durationMs} ms</span>
                  ) : null}
                </div>

                {step.error ? <p className="text-destructive text-xs">{step.error}</p> : null}

                {step.input ? (
                  <pre className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs">
                    {JSON.stringify(step.input, null, 2)}
                  </pre>
                ) : null}

                {step.output ? (
                  <pre className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs">
                    {JSON.stringify(step.output, null, 2).slice(0, 2_000)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
