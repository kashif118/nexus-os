'use client'

import { Sparkles } from 'lucide-react'
import { useActionState, useRef } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { askAction, type FormState } from '../actions'

/**
 * The assistant.
 *
 * When no provider is configured the input is disabled and says why. That is
 * the honest presentation: the alternative — a chat box that accepts a question
 * and then fails — wastes the user's time and hides a deployment problem behind
 * what looks like a product bug.
 */
export function Assistant({
  orgSlug,
  configured,
  conversationId,
  suggestions,
}: {
  orgSlug: string
  configured: boolean
  conversationId?: string | undefined
  suggestions: string[]
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    askAction.bind(null, orgSlug),
    null,
  )
  const inputRef = useRef<HTMLTextAreaElement>(null)

  if (!configured) {
    return (
      <div className="space-y-3">
        <Alert variant="warning">
          <p className="font-medium">AI generation is not configured on this deployment.</p>
          <p className="mt-1 text-xs">
            Set <code className="font-mono">ANTHROPIC_API_KEY</code> to enable the assistant.
            Everything else on this page — the findings below, usage reporting, conversation history
            — is computed from your own data and needs no provider.
          </p>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {state?.ok && state.data.answer ? (
        <div className="bg-muted rounded-md p-3 text-sm whitespace-pre-wrap">
          {state.data.answer}
        </div>
      ) : null}

      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      <form action={formAction} className="space-y-2">
        {conversationId ? (
          <input type="hidden" name="conversationId" value={conversationId} />
        ) : null}

        <label htmlFor="question" className="sr-only">
          Ask about your organization
        </label>
        <textarea
          ref={inputRef}
          id="question"
          name="question"
          rows={3}
          placeholder="Ask about projects, invoices, deals or workload…"
          className="border-input bg-background w-full rounded-md border p-3 text-sm"
        />

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" pendingLabel="Thinking…">
            <Sparkles className="size-3.5" aria-hidden="true" />
            Ask
          </SubmitButton>
          <p className="text-muted-foreground text-xs">
            It can only see what you can see, and every fact comes from a lookup.
          </p>
        </div>
      </form>

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => {
                if (inputRef.current) {
                  inputRef.current.value = suggestion
                  inputRef.current.focus()
                }
              }}
              className="border-border text-muted-foreground hover:bg-accent rounded-full border px-2.5 py-1 text-xs"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
