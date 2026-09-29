import { isProduction } from '@/kernel/config/env'
import { isRedactedField, REDACTION_MARKER } from '@/lib/ai/redact'

/**
 * Structured logging.
 *
 * `console.error('[module] something', error)` is readable by a person tailing a
 * terminal and useless to anything else. In production these lines go to a log
 * aggregator, where a line is only searchable if it has fields — you cannot
 * alert on "the third argument of a message that starts with [billing]".
 *
 * So: one JSON object per line in production, human-readable in development,
 * with the same call sites either way.
 *
 * Three rules that matter more than the format:
 *
 * 1. **An error is serialised, not stringified.** `String(error)` throws away
 *    the stack, which is the only part worth having at three in the morning.
 * 2. **Field names are redacted using the same list the AI layer uses.** There
 *    is one definition of "must not leave this process" and both use it; a log
 *    line is as much an exfiltration path as a prompt.
 * 3. **No PII in the message.** Identifiers, not names and email addresses —
 *    an organization id is enough to find the row, and a log aggregator is not
 *    a place personal data should accumulate.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

interface SerialisedError {
  name: string
  message: string
  stack?: string | undefined
  /** Our own errors carry a code; it is the most useful thing to group by. */
  code?: string | undefined
}

function serialiseError(error: unknown): SerialisedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code:
        typeof (error as { code?: unknown }).code === 'string'
          ? String((error as { code?: unknown }).code)
          : undefined,
    }
  }

  return { name: 'NonError', message: typeof error === 'string' ? error : JSON.stringify(error) }
}

/** Drop anything whose key says it should not be written down. */
function safeFields(fields: LogFields): LogFields {
  const result: LogFields = {}

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'error') continue
    result[key] = isRedactedField(key) ? REDACTION_MARKER : value
  }

  return result
}

function write(level: LogLevel, event: string, fields: LogFields): void {
  const { error, ...rest } = fields
  const payload = {
    level,
    event,
    time: new Date().toISOString(),
    ...safeFields(rest),
    ...(error === undefined ? {} : { error: serialiseError(error) }),
  }

  const line = isProduction ? JSON.stringify(payload) : readable(payload, error)

  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  // The lint rule that bans console.log exists to push every call site through
  // this function. This is that function; it has to write somewhere.
  // eslint-disable-next-line no-console
  else console.log(line)
}

function readable(payload: Record<string, unknown>, error: unknown): string {
  const { level, event, time: _time, error: _serialised, ...rest } = payload
  const context = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')

  const head = `${String(level).toUpperCase().padEnd(5)} ${event}${context ? ` ${context}` : ''}`
  if (error instanceof Error) return `${head}\n${error.stack ?? error.message}`
  return head
}

/**
 * The logger.
 *
 * `event` is a stable, dotted name — `billing.webhook.failed`, not a sentence.
 * It is what an alert is defined on, so it must not change when somebody
 * rewords a message.
 */
export const log = {
  debug: (event: string, fields: LogFields = {}) => {
    if (!isProduction) write('debug', event, fields)
  },
  info: (event: string, fields: LogFields = {}) => write('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => write('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => write('error', event, fields),
}
