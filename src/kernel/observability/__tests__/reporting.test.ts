import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildEnvelope,
  parseDsn,
  reportError,
  safeExtra,
  serialiseException,
  setErrorReporter,
  type ErrorReporter,
} from '../reporting'

/**
 * Error reporting.
 *
 * The thing worth testing here is not that an envelope reaches Sentry — no DSN
 * was available, and posting to a real ingest endpoint from a test suite would
 * be wrong anyway. It is that **nothing leaves this process that should not**,
 * and that a reporting failure can never become the error the user sees.
 */

afterEach(() => {
  setErrorReporter(undefined)
  vi.restoreAllMocks()
})

describe('parseDsn', () => {
  it('reads the key, host and project from a DSN', () => {
    const dsn = parseDsn('https://abc123@o12345.ingest.sentry.io/98765')

    expect(dsn).not.toBeNull()
    expect(dsn!.publicKey).toBe('abc123')
    expect(dsn!.projectId).toBe('98765')
    expect(dsn!.envelopeUrl).toContain('/api/98765/envelope/')
    expect(dsn!.envelopeUrl).toContain('sentry_key=abc123')
  })

  it('refuses something that is not a DSN rather than half-working', () => {
    expect(parseDsn('not a url')).toBeNull()
    expect(parseDsn('https://sentry.io/12345')).toBeNull() // no key
    expect(parseDsn('https://key@sentry.io/')).toBeNull() // no project
  })
})

describe('redaction', () => {
  it('removes a field whose name says it must not be written down', () => {
    const extra = safeExtra({
      organizationId: 'org_123',
      password: 'correct horse battery staple',
      apiKey: 'nxs_live_abc',
      sessionToken: 'tok_abc',
      costRateMinor: 9999,
    })

    expect(extra.organizationId).toBe('org_123')
    expect(extra.password).toBe('[redacted]')
    expect(extra.apiKey).toBe('[redacted]')
    expect(extra.sessionToken).toBe('[redacted]')
    // Pay data is on the same list, for the same reason.
    expect(extra.costRateMinor).toBe('[redacted]')
  })

  it('describes an object rather than serialising it', () => {
    // A nested object in an error report is almost always a request body or a
    // database row. Neither belongs on somebody else's infrastructure.
    const extra = safeExtra({
      user: { email: 'someone@example.test', name: 'Real Person' },
      rows: [{ id: 1 }],
    })

    expect(extra.user).toBe('[object]')
    expect(extra.rows).toBe('[array]')
    expect(JSON.stringify(extra)).not.toContain('example.test')
    expect(JSON.stringify(extra)).not.toContain('Real Person')
  })

  it('truncates a long string instead of shipping it whole', () => {
    const extra = safeExtra({ note: 'x'.repeat(50_000) })
    expect((extra.note as string).length).toBeLessThanOrEqual(1_000)
  })

  it('carries a bigint as text rather than throwing', () => {
    // JSON.stringify throws on a bigint, and money in this codebase is bigint.
    expect(safeExtra({ totalMinor: 150_000n }).totalMinor).toBe('150000')
  })
})

describe('serialiseException', () => {
  it('keeps the type, message and stack', () => {
    const error = new TypeError('cannot read property of undefined')
    const serialised = serialiseException(error)

    expect(serialised.type).toBe('TypeError')
    expect(serialised.value).toBe('cannot read property of undefined')
    expect(serialised.stack).toContain('reporting.test.ts')
  })

  it('survives something thrown that is not an Error', () => {
    expect(serialiseException('just a string').value).toBe('just a string')
    expect(serialiseException({ odd: true }).type).toBe('NonError')
    expect(serialiseException(undefined).type).toBe('NonError')
  })
})

describe('buildEnvelope', () => {
  const envelope = () =>
    buildEnvelope({
      eventId: 'a'.repeat(32),
      timestamp: 1_790_000_000_000,
      exception: serialiseException(new Error('it broke')),
      context: {
        event: 'billing.webhook.failed',
        tags: { organizationId: 'org_1', missing: undefined },
        extra: { attempt: 2, password: 'secret' },
      },
      environment: 'production',
      release: 'v1.2.3',
      serverName: 'web-1',
    })

  it('is three newline-delimited JSON objects', () => {
    const lines = envelope().trim().split('\n')

    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('carries the event name as both logger and tag, so an alert can key on it', () => {
    const payload = JSON.parse(envelope().trim().split('\n')[2]!)

    expect(payload.logger).toBe('billing.webhook.failed')
    expect(payload.tags.event).toBe('billing.webhook.failed')
    expect(payload.tags.organizationId).toBe('org_1')
    // An undefined tag is dropped rather than sent as the string "undefined".
    expect(payload.tags.missing).toBeUndefined()
  })

  it('redacts extras on the way into the envelope', () => {
    const body = envelope()

    expect(body).not.toContain('secret')
    expect(body).toContain('[redacted]')
  })

  it('records the exception and environment', () => {
    const payload = JSON.parse(envelope().trim().split('\n')[2]!)

    expect(payload.exception.values[0].type).toBe('Error')
    expect(payload.exception.values[0].value).toBe('it broke')
    expect(payload.environment).toBe('production')
    expect(payload.release).toBe('v1.2.3')
    expect(payload.extra.stacktrace).toContain('reporting.test.ts')
  })
})

describe('reportError', () => {
  it('does nothing when no reporter is configured', () => {
    // The default state of this repository, and it must be silent rather than
    // throwing on every logged error.
    expect(() => reportError(new Error('x'), { event: 'test' })).not.toThrow()
  })

  it('hands the error to a configured reporter', async () => {
    const seen: Array<{ error: unknown; event: string }> = []

    const reporter: ErrorReporter = {
      id: 'fake',
      async report(error, context) {
        seen.push({ error, event: context.event })
      },
    }
    setErrorReporter(reporter)

    reportError(new Error('boom'), { event: 'workflows.run.failed' })
    await Promise.resolve()

    expect(seen).toHaveLength(1)
    expect(seen[0]!.event).toBe('workflows.run.failed')
  })

  it('swallows a reporter that throws', async () => {
    setErrorReporter({
      id: 'broken',
      async report() {
        throw new Error('the reporting service is down')
      },
    })

    // A failure to report must never replace the real error, and must never
    // surface as an unhandled rejection.
    expect(() => reportError(new Error('real'), { event: 'test' })).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
  })

  it('does not block the caller', () => {
    let finished = false

    setErrorReporter({
      id: 'slow',
      report: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            finished = true
            resolve()
          }, 50)
        }),
    })

    reportError(new Error('x'), { event: 'test' })

    // Returned before the report completed, which is the point: a request must
    // not wait on telemetry.
    expect(finished).toBe(false)
  })
})
