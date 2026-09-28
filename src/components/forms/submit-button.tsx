'use client'

import { useFormStatus } from 'react-dom'

import { Button, type ButtonProps } from '@/components/ui/button'

/**
 * Submit button that disables itself while its form is pending.
 *
 * `useFormStatus` reads the state of the enclosing form, so this works with
 * plain server actions and needs no state plumbing from the page.
 */
export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending} aria-busy={pending} {...props}>
      {pending ? (pendingLabel ?? 'Working…') : children}
    </Button>
  )
}
