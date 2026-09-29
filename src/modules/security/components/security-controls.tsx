'use client'

import { useActionState, useState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'

import {
  createApiKeyAction,
  revokeApiKeyAction,
  revokeSessionAction,
  updatePolicyAction,
  type FormState,
} from '../actions'

/** End one session. */
export function RevokeSessionButton({
  orgSlug,
  sessionId,
  label,
}: {
  orgSlug: string
  sessionId: string
  label: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    revokeSessionAction.bind(null, orgSlug),
    null,
  )

  if (state?.ok) return <span className="text-muted-foreground text-xs">Ended.</span>

  return (
    <form action={formAction}>
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="id" value={sessionId} />
      <SubmitButton size="sm" variant="ghost" pendingLabel="Ending…">
        {label}
      </SubmitButton>
    </form>
  )
}

/**
 * Create an API key.
 *
 * The plaintext is shown once, here, and the copy says so plainly — because it
 * is true, not as a convention. Nothing stores it, so there is no "reveal"
 * that could be added later.
 */
export function CreateApiKeyForm({
  orgSlug,
  grantableScopes,
}: {
  orgSlug: string
  grantableScopes: Array<{ key: string; label: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createApiKeyAction.bind(null, orgSlug),
    null,
  )
  const [copied, setCopied] = useState(false)

  const fields = state && !state.ok ? state.error.fields : undefined
  const plaintext = state?.ok ? state.data.plaintext : undefined

  if (plaintext) {
    return (
      <div className="space-y-3">
        <Alert variant="warning">
          <p className="font-medium">Copy this key now.</p>
          <p className="mt-1 text-xs">
            It is stored only as a hash, so this is the one and only time it can be shown. If you
            lose it, revoke this key and make another.
          </p>
        </Alert>

        <code className="bg-muted block overflow-x-auto rounded-md p-3 font-mono text-xs">
          {plaintext}
        </code>

        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(plaintext).then(() => setCopied(true))
          }}
          className="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
        >
          {copied ? 'Copied' : 'Copy to clipboard'}
        </button>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      <Field name="name" label="What is it for?" required errors={fields?.name} />

      <Field
        name="expiresInDays"
        label="Expires after (days)"
        inputMode="numeric"
        placeholder="Leave blank for no expiry"
      />

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">What may it do?</legend>
        <p className="text-muted-foreground text-xs">
          Only permissions you hold yourself are listed. A key can never do more than you can, and
          stops working for anything you lose access to.
        </p>
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
          {grantableScopes.map((scope) => (
            <label key={scope.key} className="flex items-start gap-2 text-xs">
              <input type="checkbox" name="scope" value={scope.key} className="mt-0.5 size-3.5" />
              <span>
                <code className="font-mono">{scope.key}</code>
                <span className="text-muted-foreground"> — {scope.label}</span>
              </span>
            </label>
          ))}
        </div>
        {fields?.scopes ? (
          <p className="text-destructive text-xs">{fields.scopes.join(' ')}</p>
        ) : null}
      </fieldset>

      <SubmitButton size="sm" pendingLabel="Creating…">
        Create key
      </SubmitButton>
    </form>
  )
}

/** Revoke a key. */
export function RevokeApiKeyButton({ orgSlug, keyId }: { orgSlug: string; keyId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(
    revokeApiKeyAction.bind(null, orgSlug),
    null,
  )

  if (state?.ok) return <span className="text-muted-foreground text-xs">Revoked.</span>

  return (
    <form action={formAction}>
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="id" value={keyId} />
      <SubmitButton size="sm" variant="ghost" pendingLabel="Revoking…">
        Revoke
      </SubmitButton>
    </form>
  )
}

/** Organization security settings. */
export function SecurityPolicyForm({
  orgSlug,
  policy,
}: {
  orgSlug: string
  policy: { sessionIdleMinutes: number; allowedIpRanges: string[]; alertOnNewIp: boolean }
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    updatePolicyAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <Field
        name="sessionIdleMinutes"
        label="Sign people out after (minutes of inactivity)"
        inputMode="numeric"
        defaultValue={String(policy.sessionIdleMinutes)}
        errors={fields?.sessionIdleMinutes}
      />

      <div className="space-y-1.5">
        <Label htmlFor="allowedIpRanges">Only allow sign-in from these addresses</Label>
        <textarea
          id="allowedIpRanges"
          name="allowedIpRanges"
          rows={3}
          defaultValue={policy.allowedIpRanges.join('\n')}
          placeholder="203.0.113.0/24"
          className="border-input bg-background w-full rounded-md border p-2 font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">
          One range per line, in CIDR notation. Leave empty to allow any address.{' '}
          <strong>An incorrect entry locks everybody out</strong>, including you — check it from the
          network you will be on.
        </p>
        {fields?.allowedIpRanges ? (
          <p className="text-destructive text-xs">{fields.allowedIpRanges.join(' ')}</p>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="alertOnNewIp"
          value="on"
          defaultChecked={policy.alertOnNewIp}
          className="size-4"
        />
        Notify when somebody signs in from a new address
      </label>

      <SubmitButton size="sm" pendingLabel="Saving…">
        Save settings
      </SubmitButton>
    </form>
  )
}
