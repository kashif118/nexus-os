import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log } from '../logger'

/**
 * The logger.
 *
 * Two things are worth testing here and the format is not one of them: that an
 * error keeps its stack, and that a field which should never leave the process
 * does not leave it through a log line. A log aggregator is as much an
 * exfiltration path as an AI prompt, and it is the one people forget.
 */

let errors: unknown[][]
let warns: unknown[][]
let logs: unknown[][]

beforeEach(() => {
  errors = []
  warns = []
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args))
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warns.push(args))
  vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const lastError = () => String(errors.at(-1)?.[0] ?? '')

describe('log', () => {
  it('writes errors to console.error and warnings to console.warn', () => {
    log.error('billing.webhook.failed', { provider: 'stripe' })
    log.warn('billing.webhook.slow', { provider: 'stripe' })

    expect(errors).toHaveLength(1)
    expect(warns).toHaveLength(1)
    expect(lastError()).toContain('billing.webhook.failed')
  })

  it('keeps the stack, which is the only part worth having', () => {
    const error = new Error('the connection dropped')

    log.error('database.query.failed', { error })

    const line = lastError()
    expect(line).toContain('the connection dropped')
    expect(line).toContain('logger.test.ts')
  })

  it('survives something thrown that is not an Error', () => {
    log.error('odd.failure', { error: 'just a string' })
    expect(lastError()).toContain('odd.failure')

    log.error('odder.failure', { error: { unexpected: true } })
    expect(lastError()).toContain('odder.failure')
  })

  it('redacts a field whose name says it must not be written down', () => {
    log.error('auth.signin.failed', {
      membershipId: 'mem_123',
      password: 'correct horse battery staple',
      apiKey: 'nxs_live_abcdefgh',
      sessionToken: 'tok_abcdefgh',
    })

    const line = lastError()

    // The identifier survives — it is how you find the row.
    expect(line).toContain('mem_123')

    // The secrets do not.
    expect(line).not.toContain('correct horse battery staple')
    expect(line).not.toContain('nxs_live_abcdefgh')
    expect(line).not.toContain('tok_abcdefgh')
    expect(line).toContain('[redacted]')
  })

  it('names the event, not the sentence, so an alert can be defined on it', () => {
    log.error('workflows.run.failed', { runId: 'run_1' })

    expect(lastError()).toContain('workflows.run.failed')
    expect(lastError()).toContain('run_1')
  })
})
