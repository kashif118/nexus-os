'use client'

import { useEffect } from 'react'

/**
 * Report uncaught browser errors.
 *
 * The server side has had structured logging since Phase 23; the browser had
 * nothing. A hydration failure, a null dereference in a client component or a
 * rejected fetch in an event handler produced a broken screen for the user and
 * silence for everybody else.
 *
 * Mounted once in the root layout. It sends to this application's own endpoint,
 * so no vendor script runs in the page and the Content-Security-Policy needs no
 * exception.
 *
 * What is NOT sent: the query string, form values, cookies, or anything from
 * the DOM. A message, a stack and a path — enough to find the code, and not a
 * copy of whatever the user was typing.
 */

/** One report per message per session. A loop must not become a flood. */
const reported = new Set<string>()
const MAX_DISTINCT = 10

function send(payload: {
  kind: 'error' | 'unhandledrejection'
  message: string
  stack?: string | undefined
}): void {
  const key = `${payload.kind}:${payload.message}`
  if (reported.has(key) || reported.size >= MAX_DISTINCT) return
  reported.add(key)

  const body = JSON.stringify({
    ...payload,
    // Path only. A query string can carry a token, a search term or an email
    // address, none of which belong in telemetry.
    path: window.location.pathname,
  })

  // `keepalive` so a report survives the navigation that a crash often causes.
  void fetch('/api/telemetry/error', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // A telemetry failure is not worth a second error.
  })
}

export function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      send({
        kind: 'error',
        message: event.message || 'Uncaught error',
        stack: event.error instanceof Error ? event.error.stack : undefined,
      })
    }

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason
      send({
        kind: 'unhandledrejection',
        message:
          reason instanceof Error
            ? reason.message
            : typeof reason === 'string'
              ? reason
              : 'Unhandled promise rejection',
        stack: reason instanceof Error ? reason.stack : undefined,
      })
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}

/**
 * Report an error caught by a React error boundary.
 *
 * Exported separately because a boundary already has the error in hand and does
 * not go through `window.onerror`.
 */
export function reportBoundaryError(error: Error & { digest?: string }): void {
  void fetch('/api/telemetry/error', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'boundary',
      message: error.message || 'Render failed',
      stack: error.stack,
      digest: error.digest,
      path: typeof window === 'undefined' ? undefined : window.location.pathname,
    }),
    keepalive: true,
  }).catch(() => {})
}
