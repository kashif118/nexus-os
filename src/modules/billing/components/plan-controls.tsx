'use client'

import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'

import { openPortalAction, setPlanAction, startCheckoutAction, type FormState } from '../actions'

/**
 * Plan controls.
 *
 * What the button does depends on whether a payment provider is configured, and
 * the copy says which. With a provider, "Choose" starts a checkout and nothing
 * changes until the provider says so. Without one, "Set this plan" changes the
 * plan directly and is recorded as a manual change — because in that deployment
 * there is no payment for the application to observe.
 */
export function PlanControls({
  orgSlug,
  planKey,
  current,
  configured,
  hasBillingAccount,
}: {
  orgSlug: string
  planKey: string
  current: boolean
  configured: boolean
  hasBillingAccount: boolean
}) {
  const [checkoutState, checkout] = useActionState<FormState, FormData>(
    startCheckoutAction.bind(null, orgSlug),
    null,
  )
  const [portalState, portal] = useActionState<FormState, FormData>(
    openPortalAction.bind(null, orgSlug),
    null,
  )
  const [manualState, setPlan] = useActionState<FormState, FormData>(
    setPlanAction.bind(null, orgSlug),
    null,
  )

  const failure = [checkoutState, portalState, manualState].find((entry) => entry && !entry.ok)

  if (current) {
    return (
      <div className="space-y-2">
        {failure && !failure.ok ? (
          <Alert variant="destructive">{failure.error.message}</Alert>
        ) : null}

        {configured && hasBillingAccount ? (
          <form action={portal}>
            <SubmitButton size="sm" variant="outline" pendingLabel="Opening…">
              Manage billing
            </SubmitButton>
          </form>
        ) : (
          <p className="text-muted-foreground text-xs">This is the current plan.</p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {failure && !failure.ok ? <Alert variant="destructive">{failure.error.message}</Alert> : null}
      {manualState?.ok ? <Alert variant="success">{manualState.data.message}</Alert> : null}

      {configured ? (
        planKey === 'free' ? (
          <p className="text-muted-foreground text-xs">
            Cancel through &ldquo;Manage billing&rdquo; to return to the free plan at the end of the
            paid period.
          </p>
        ) : (
          <form action={checkout}>
            <input type="hidden" name="plan" value={planKey} />
            <SubmitButton size="sm" pendingLabel="Opening…">
              Choose {planKey}
            </SubmitButton>
            <p className="text-muted-foreground mt-1 text-xs">
              Takes you to the payment provider. Nothing changes here until they confirm it.
            </p>
          </form>
        )
      ) : (
        <form action={setPlan}>
          <input type="hidden" name="plan" value={planKey} />
          <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
            Set this plan
          </SubmitButton>
          <p className="text-muted-foreground mt-1 text-xs">
            No payment provider is configured, so this is recorded as an administrator&rsquo;s
            decision rather than as an observed payment.
          </p>
        </form>
      )}
    </div>
  )
}
