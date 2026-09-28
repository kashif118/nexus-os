'use client'

import { useEffect } from 'react'

import { Button } from '@/components/ui/button'

/**
 * Route-level error boundary.
 *
 * Users never see a stack trace (docs/OPERATIONS.md §M.6). The digest is shown
 * so a support request can be tied to a server log entry. Phase 02 replaces the
 * console call with the structured logger and Sentry.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground text-sm">
          The error has been recorded. Try again, and contact support if it continues.
        </p>
        {error.digest ? (
          <p className="text-muted-foreground font-mono text-xs">Reference: {error.digest}</p>
        ) : null}
        <Button className="mt-2" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  )
}
