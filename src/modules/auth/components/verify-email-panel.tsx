'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'

import { verifyEmailAction } from '../actions'
import type { ActionResult } from '@/kernel/errors'

type State = ActionResult<{ message: string }> | null

/**
 * Email confirmation requires a deliberate click rather than happening on page
 * load.
 *
 * Verification tokens are single-use, and mail clients, link scanners and
 * security gateways routinely fetch every URL in a message. Consuming the token
 * on GET would let a scanner burn it before the recipient ever opened the mail.
 */
export function VerifyEmailPanel({ token }: { token: string }) {
  const [state, formAction] = useActionState<State, FormData>(
    async () => verifyEmailAction(token),
    null,
  )

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <Alert variant="success">{state.data.message}</Alert>
        <Link
          href="/account"
          className={buttonVariants({ variant: 'outline', className: 'w-full' })}
        >
          Go to your account
        </Link>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <SubmitButton className="w-full" pendingLabel="Confirming…">
        Confirm email address
      </SubmitButton>
    </form>
  )
}
