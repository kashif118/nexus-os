'use client'

import { useActionState, useState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { closeDealAction, convertLeadAction, type FormState } from '../actions'

/**
 * Close a deal as won or lost.
 *
 * Marking lost asks for a reason before submitting: a lost-reason field that is
 * optional in practice ends up empty, and lost reasons are the most useful thing
 * in a pipeline review.
 */
export function CloseDealControls({ orgSlug, dealId }: { orgSlug: string; dealId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(
    closeDealAction.bind(null, orgSlug),
    null,
  )
  const [showLost, setShowLost] = useState(false)

  return (
    <div className="space-y-2 border-t pt-3">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      {showLost ? (
        <form action={formAction} className="space-y-2">
          <input type="hidden" name="dealId" value={dealId} />
          <input type="hidden" name="outcome" value="LOST" />
          <label className="sr-only" htmlFor="lostReason">
            Reason
          </label>
          <Input id="lostReason" name="lostReason" placeholder="Why was it lost?" />
          <div className="flex gap-2">
            <SubmitButton variant="destructive" size="sm" pendingLabel="Saving…">
              Mark lost
            </SubmitButton>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowLost(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2">
          <form action={formAction}>
            <input type="hidden" name="dealId" value={dealId} />
            <input type="hidden" name="outcome" value="WON" />
            <SubmitButton size="sm" pendingLabel="Saving…">
              Mark won
            </SubmitButton>
          </form>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowLost(true)}>
            Mark lost
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Convert a lead into a company, contact and optionally a deal.
 *
 * The lead is not destroyed by conversion, so this is safe to offer inline.
 */
export function ConvertLeadControls({
  orgSlug,
  leadId,
  leadName,
  currency,
  canCreateDeal,
}: {
  orgSlug: string
  leadId: string
  leadName: string
  currency: string
  canCreateDeal: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    convertLeadAction.bind(null, orgSlug),
    null,
  )

  if (state?.ok) {
    return <Alert variant="success">{state.data.message}</Alert>
  }

  return (
    <form action={formAction} className="space-y-3">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="leadId" value={leadId} />

      <p className="text-muted-foreground text-sm">
        Creates a company and a contact from this lead. The lead is kept, linked to what it became,
        so the source stays attributable.
      </p>

      {canCreateDeal ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="createDeal" value="on" defaultChecked className="size-4" />
            Also create a deal
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="dealTitle" className="text-xs font-medium">
                Deal title
              </label>
              <Input id="dealTitle" name="dealTitle" defaultValue={`${leadName} opportunity`} />
            </div>
            <div className="space-y-1">
              <label htmlFor="dealValue" className="text-xs font-medium">
                Value ({currency})
              </label>
              <Input id="dealValue" name="dealValue" inputMode="decimal" placeholder="0.00" />
            </div>
          </div>
        </div>
      ) : null}

      <SubmitButton size="sm" pendingLabel="Converting…">
        Convert lead
      </SubmitButton>
    </form>
  )
}
