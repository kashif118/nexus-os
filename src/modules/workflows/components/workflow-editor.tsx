'use client'

import { useActionState, useState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { publishWorkflowAction, saveDraftAction, type FormState } from '../actions'

export interface TriggerSummary {
  type: string
  label: string
  description: string
  entityType: string
  fields: Array<{ path: string; label: string; type: string }>
}

export interface ActionSummary {
  type: string
  label: string
  description: string
  category: string
  requiredPermissions: string[]
  sideEffect: string
  idempotent: boolean
}

/**
 * The workflow editor.
 *
 * The graph is edited as JSON with a live reference to the registries beside
 * it. That is a deliberate choice rather than a shortcut: a drag-and-drop
 * canvas is a large amount of UI whose only job is to produce this same
 * document, and shipping a half-working canvas would make the engine look less
 * capable than it is. The validation — which is the part that actually protects
 * the author — is identical either way, and runs on the server.
 *
 * The palette below is generated from the registries, so a new trigger or
 * action appears here the moment it is registered, with no change to this file.
 */
export function WorkflowEditor({
  orgSlug,
  workflowId,
  graph,
  triggers,
  actions,
  issues,
  canPublish,
}: {
  orgSlug: string
  workflowId: string
  graph: unknown
  triggers: TriggerSummary[]
  actions: ActionSummary[]
  issues: string[]
  canPublish: boolean
}) {
  const [saveState, save] = useActionState<FormState, FormData>(
    saveDraftAction.bind(null, orgSlug),
    null,
  )
  const [publishState, publish] = useActionState<FormState, FormData>(
    publishWorkflowAction.bind(null, orgSlug),
    null,
  )

  const [value, setValue] = useState(() => JSON.stringify(graph, null, 2))
  const [showReference, setShowReference] = useState(false)

  return (
    <div className="space-y-4">
      {saveState?.ok ? <Alert variant="success">{saveState.data.message}</Alert> : null}
      {saveState && !saveState.ok ? (
        <Alert variant="destructive">
          {saveState.error.message}
          {saveState.error.fields?.graph ? (
            <ul className="mt-1 list-inside list-disc text-xs">
              {saveState.error.fields.graph.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      {publishState?.ok ? <Alert variant="success">{publishState.data.message}</Alert> : null}
      {publishState && !publishState.ok ? (
        <Alert variant="destructive">
          {publishState.error.message}
          {publishState.error.fields?.graph ? (
            <ul className="mt-1 list-inside list-disc text-xs">
              {publishState.error.fields.graph.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      {issues.length > 0 ? (
        <Alert variant="warning">
          <p className="font-medium">Not publishable yet:</p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <form action={save} className="space-y-3">
        <input type="hidden" name="id" value={workflowId} />
        <input type="hidden" name="graph" value={value} />

        <label htmlFor="graph-editor" className="text-sm font-medium">
          Graph
        </label>
        <textarea
          id="graph-editor"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          rows={22}
          className="border-input bg-background w-full rounded-md border p-3 font-mono text-xs"
        />

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" pendingLabel="Saving…">
            Save draft
          </SubmitButton>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowReference((current) => !current)}
          >
            {showReference ? 'Hide' : 'Show'} triggers and actions
          </Button>
        </div>
      </form>

      {canPublish ? (
        <form action={publish} className="border-t pt-4">
          <input type="hidden" name="id" value={workflowId} />
          <SubmitButton size="sm" variant="outline" pendingLabel="Publishing…">
            Publish and activate
          </SubmitButton>
          <p className="text-muted-foreground mt-1 text-xs">
            Publishing snapshots the graph. Runs already in flight keep the version they started on.
          </p>
        </form>
      ) : null}

      {showReference ? (
        <div className="grid gap-4 border-t pt-4 md:grid-cols-2">
          <section>
            <h3 className="mb-2 text-sm font-medium">Triggers</h3>
            <ul className="space-y-3 text-xs">
              {triggers.map((trigger) => (
                <li key={trigger.type}>
                  <code className="font-mono">{trigger.type}</code>
                  <p className="text-muted-foreground">{trigger.description}</p>
                  <p className="text-muted-foreground">
                    Fields: {trigger.fields.map((field) => field.path).join(', ') || 'none'}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Actions</h3>
            <ul className="space-y-3 text-xs">
              {actions.map((action) => (
                <li key={action.type}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono">{action.type}</code>
                    <Badge variant={action.sideEffect === 'external' ? 'warning' : 'neutral'}>
                      {action.sideEffect}
                    </Badge>
                    {action.idempotent ? null : <Badge variant="neutral">not repeatable</Badge>}
                  </span>
                  <p className="text-muted-foreground">{action.description}</p>
                  {action.requiredPermissions.length > 0 ? (
                    <p className="text-muted-foreground">
                      Needs: {action.requiredPermissions.join(', ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  )
}
