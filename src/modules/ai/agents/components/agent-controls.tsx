'use client'

import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import {
  acceptProposalAction,
  configureAgentAction,
  rejectProposalAction,
  runAgentAction,
  type FormState,
} from '../actions'

export interface AgentSummary {
  key: string
  name: string
  description: string
  whatItDoes: string
  tools: string[]
  writeTools: string[]
  enabled: boolean
  autonomy: string
  owner: string | null
  ownerMembershipId: string | null
  extraInstructions: string | null
  canRun: boolean
}

/**
 * Configure one agent.
 *
 * The owner field is the important one, and the copy says why: the agent acts
 * with that person's permissions, so choosing an owner is granting access, not
 * picking a label.
 */
export function AgentConfigForm({
  orgSlug,
  agent,
  people,
  canManage,
}: {
  orgSlug: string
  agent: AgentSummary
  people: Array<{ id: string; name: string }>
  canManage: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    configureAgentAction.bind(null, orgSlug),
    null,
  )

  if (!canManage) {
    return (
      <p className="text-muted-foreground text-xs">
        {agent.enabled
          ? `Switched on, acting as ${agent.owner ?? 'nobody'}.`
          : 'Switched off. Someone who can change AI settings must enable it.'}
      </p>
    )
  }

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      <input type="hidden" name="agentKey" value={agent.key} />

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          value="on"
          defaultChecked={agent.enabled}
          className="size-4"
        />
        Switched on
      </label>

      <div className="space-y-1.5">
        <Label htmlFor={`owner-${agent.key}`}>Acts as</Label>
        <NativeSelect
          id={`owner-${agent.key}`}
          name="ownerMembershipId"
          defaultValue={agent.ownerMembershipId ?? ''}
        >
          <option value="">Nobody</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          The agent can see and do exactly what this person can, and no more.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`autonomy-${agent.key}`}>When it wants to change something</Label>
        <NativeSelect id={`autonomy-${agent.key}`} name="autonomy" defaultValue={agent.autonomy}>
          <option value="SUGGEST">Ask first (recommended)</option>
          <option value="AUTONOMOUS">Do it</option>
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          Ask first records a proposal that somebody accepts. Do it carries the change out
          immediately, within the owner&rsquo;s permissions.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`extra-${agent.key}`}>Extra instructions</Label>
        <Textarea
          id={`extra-${agent.key}`}
          name="extraInstructions"
          rows={2}
          defaultValue={agent.extraInstructions ?? ''}
          placeholder="Anything specific to how your organization works."
        />
        <p className="text-muted-foreground text-xs">
          Added to its instructions. It cannot replace them or widen what it may do.
        </p>
      </div>

      <SubmitButton size="sm" pendingLabel="Saving…">
        Save
      </SubmitButton>
    </form>
  )
}

/** Run an agent now. */
export function RunAgentForm({
  orgSlug,
  agentKey,
  enabled,
  canRun,
}: {
  orgSlug: string
  agentKey: string
  enabled: boolean
  canRun: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    runAgentAction.bind(null, orgSlug),
    null,
  )

  if (!canRun) {
    return (
      <p className="text-muted-foreground text-xs">You do not have permission to run this agent.</p>
    )
  }

  return (
    <form action={formAction} className="space-y-2">
      {state?.ok && state.data.summary ? (
        <div className="bg-muted rounded-md p-3 text-sm whitespace-pre-wrap">
          {state.data.summary}
        </div>
      ) : null}
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      <input type="hidden" name="agentKey" value={agentKey} />
      <input
        name="question"
        placeholder="Anything specific to look at? (optional)"
        className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
      />

      <SubmitButton size="sm" variant="outline" pendingLabel="Working…" disabled={!enabled}>
        {enabled ? 'Run now' : 'Switch it on first'}
      </SubmitButton>
    </form>
  )
}

/** Accept or reject one proposal. */
export function ProposalControls({
  orgSlug,
  proposalId,
  summary,
  toolName,
}: {
  orgSlug: string
  proposalId: string
  summary: string
  toolName: string
}) {
  const [acceptState, accept] = useActionState<FormState, FormData>(
    acceptProposalAction.bind(null, orgSlug),
    null,
  )
  const [rejectState, reject] = useActionState<FormState, FormData>(
    rejectProposalAction.bind(null, orgSlug),
    null,
  )

  const settled = acceptState?.ok || rejectState?.ok
  const failure = [acceptState, rejectState].find((entry) => entry && !entry.ok)

  return (
    <div className="space-y-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm">{summary}</p>
          <p className="text-muted-foreground text-xs">
            <Badge variant="neutral">{toolName}</Badge> — nothing has happened yet.
          </p>
        </div>

        {settled ? (
          <p className="text-muted-foreground text-xs">
            {acceptState?.ok ? acceptState.data.message : rejectState?.ok ? 'Rejected.' : ''}
          </p>
        ) : (
          <div className="flex gap-2">
            <form action={accept}>
              <input type="hidden" name="id" value={proposalId} />
              <SubmitButton size="sm" pendingLabel="Doing…">
                Accept
              </SubmitButton>
            </form>
            <form action={reject}>
              <input type="hidden" name="id" value={proposalId} />
              <SubmitButton size="sm" variant="ghost" pendingLabel="…">
                Reject
              </SubmitButton>
            </form>
          </div>
        )}
      </div>

      {failure && !failure.ok ? <Alert variant="destructive">{failure.error.message}</Alert> : null}
    </div>
  )
}
