import { clientEnv } from '@/kernel/config/env'

/**
 * Outbound email port.
 *
 * Phase 02 ships the port and a development transport only. A Resend adapter
 * lands with the notifications work, when `RESEND_API_KEY` is configured — at
 * which point this file gains one implementation and nothing else changes.
 *
 * The console transport is not a stub standing in for missing behaviour: the
 * verification and reset FLOWS are complete and testable. Only delivery is
 * local, and it is loud about that.
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

let mailer: Mailer = new ConsoleMailer()

export const getMailer = (): Mailer => mailer

/** Test seam: swap the transport for an in-memory recorder. */
export const setMailer = (next: Mailer): void => {
  mailer = next
}

export const absoluteUrl = (path: string): string =>
  new URL(path, clientEnv.NEXT_PUBLIC_APP_URL).toString()
