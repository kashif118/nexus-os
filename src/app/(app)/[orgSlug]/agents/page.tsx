import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { aiStatus } from '@/modules/ai/queries'
import {
  AgentConfigForm,
  ProposalControls,
  RunAgentForm,
} from '@/modules/ai/agents/components/agent-controls'
import { listAgentsWithConfig, listPendingProposals, listRuns } from '@/modules/ai/agents/queries'
import { listShareTargets } from '@/modules/documents/queries'
import { relativeTime } from '@/lib/format'

export const metadata: Metadata = { title: 'Agents' }

/**
 * Agents.
 *
 * The page is organised around the thing that matters: an agent PROPOSES and a
 * person DISPOSES. Proposals waiting on somebody come first, then the agents
 * themselves, then what they have done.
 */
export default async function AgentsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.can('ai.use')) notFound()

  const canManage = ctx.can('ai.settings.manage')

  const [agents, proposals, runs, people] = await Promise.all([
    listAgentsWithConfig(ctx),
    listPendingProposals(ctx),
    listRuns(ctx),
    canManage ? listShareTargets(ctx) : Promise.resolve({ people: [], teams: [] }),
  ])

  const status = aiStatus()
  const agentName = new Map(agents.map((agent) => [agent.key, agent.name]))

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="Agents"
        description="Each one acts with one person's permissions, proposes rather than acts, and shows its working."
      />

      {!status.configured ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm">
              AI generation is not configured on this deployment, so agents cannot run. Their
              settings and past runs are still here.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {proposals.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for you</CardTitle>
            <CardDescription>
              An agent wants to make these changes. None of them has happened.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-border divide-y">
            {proposals.map((proposal) => (
              <ProposalControls
                key={proposal.id}
                orgSlug={orgSlug}
                proposalId={proposal.id}
                summary={proposal.summary}
                toolName={proposal.toolName}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((agent) => (
          <Card key={agent.key}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">{agent.name}</CardTitle>
                <Badge variant={agent.enabled ? 'success' : 'neutral'}>
                  {agent.enabled ? 'On' : 'Off'}
                </Badge>
              </div>
              <CardDescription>{agent.whatItDoes}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-muted-foreground space-y-1 text-xs">
                <p>
                  Can use: {agent.tools.join(', ')}
                  {agent.writeTools.length === 0 ? ' (read only)' : ''}
                </p>
                {agent.owner ? <p>Acts as {agent.owner}.</p> : null}
              </div>

              <RunAgentForm
                orgSlug={orgSlug}
                agentKey={agent.key}
                enabled={agent.enabled && status.configured}
                canRun={agent.canRun}
              />

              <details className="border-t pt-3">
                <summary className="cursor-pointer text-xs font-medium">Settings</summary>
                <div className="pt-3">
                  <AgentConfigForm
                    orgSlug={orgSlug}
                    agent={agent}
                    people={people.people}
                    canManage={canManage}
                  />
                </div>
              </details>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>Every run records what it looked at and why.</CardDescription>
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
                      href={`/${orgSlug}/agents/runs/${run.id}`}
                      className="font-medium hover:underline"
                    >
                      {agentName.get(run.agentKey) ?? run.agentKey}
                    </Link>
                    <p className="text-muted-foreground truncate text-xs">
                      {relativeTime(run.startedAt)} · {run._count.steps} step
                      {run._count.steps === 1 ? '' : 's'} · {run._count.proposals} proposal
                      {run._count.proposals === 1 ? '' : 's'}
                      {run.error ? ` · ${run.error}` : ''}
                    </p>
                  </div>
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
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
