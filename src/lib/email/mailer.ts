import { clientEnv } from '@/kernel/config/env'

import { createConfiguredMailer } from './transports'

/**
 * Outbound email port.
 *
 * Two real transports live in `./transports` — SMTP and Resend — selected by
 * `EMAIL_PROVIDER`. The console transport below remains the default, and is for
 * development only: it prints the message, including verification and reset
 * links, to the server log.
 *
 * A deployment left on `console` accepts sign-ups and then strands every one of
 * them, because nobody receives the link that finishes the account. That is why
 * `npm run check:production` treats it as a blocker rather than a preference.
 */

export interface EmailMessage {
  to: string
  subject: string
  /** Plain-text body. Templated HTML arrives with the Resend adapter. */
  text: string
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>
}

class ConsoleMailer implements Mailer {
  async send(message: EmailMessage): Promise<void> {
    console.warn(
      [
        '',
        '─────────────────────────────────────────────────────────────',
        ' EMAIL NOT SENT — no transport configured (development only)',
        `   to:      ${message.to}`,
        `   subject: ${message.subject}`,
        '',
        message.text,
        '─────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    )
  }
}

let mailer: Mailer | undefined
let override: Mailer | undefined

/**
 * The configured transport.
 *
 * Resolved on first use rather than at module load, so importing this module
 * never triggers configuration validation — a build with no email settings
 * still succeeds, and a misconfiguration fails at the first send with a message
 * naming the missing variable.
 */
export function getMailer(): Mailer {
  if (override) return override
  if (mailer) return mailer

  mailer = createConfiguredMailer() ?? new ConsoleMailer()
  return mailer
}

/** Test seam: swap the transport for an in-memory recorder. */
export const setMailer = (next: Mailer | undefined): void => {
  override = next
  mailer = undefined
}

export const absoluteUrl = (path: string): string =>
  new URL(path, clientEnv.NEXT_PUBLIC_APP_URL).toString()
