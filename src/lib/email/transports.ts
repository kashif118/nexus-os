import type { Socket } from 'node:net'

import { getEmailConfig } from '@/kernel/config/env'

import type { EmailMessage, Mailer } from './mailer'

/**
 * Real email transports.
 *
 * Until now the only transport printed to the console, which the engineering
 * report classified as an optional gap. It is not optional: verification and
 * password-reset links are the two things a new account cannot proceed without,
 * so a deployment with no transport accepts sign-ups and then strands every one
 * of them. §22 of the report listed email as "optional"; that was wrong, and
 * the production preflight now treats it as a blocker.
 *
 * ## Two transports, and why
 *
 * - **Resend** (`EMAIL_PROVIDER=resend`) — an HTTPS call, which is what a
 *   serverless platform is good at. Preferred on Vercel.
 * - **SMTP** (`EMAIL_PROVIDER=smtp`) — for self-hosting, or an existing relay.
 *   Implemented directly over TLS sockets rather than through Nodemailer: the
 *   subset needed here is one AUTH LOGIN and one message, and the dependency
 *   would be carrying a MIME builder, an OAuth2 client and a pooled connection
 *   manager to send plain text. That trade is stated because it is a real one —
 *   this implementation does not do connection pooling, DKIM signing, or
 *   attachments, and if any of those become necessary Nodemailer is the answer.
 *
 * ## Verification status
 *
 * BLOCKED: neither transport has been exercised against a live server, because
 * no credentials were available. The message construction and the SMTP dialogue
 * are unit-tested against a scripted fake server; the network path is not.
 */

/* -------------------------------------------------------------------------- */
/* Message construction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fold a header value and strip anything that could inject another header.
 *
 * The important half is the stripping. A subject containing CR or LF can
 * introduce arbitrary headers — a `Bcc:` being the obvious abuse — and subjects
 * here are partly derived from user-supplied data such as an organization name.
 */
export function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 5322 date, which some relays reject a message for lacking. */
function rfc5322Date(now: Date): string {
  return now.toUTCString().replace('GMT', '+0000')
}

export function buildMimeMessage(message: EmailMessage, from: string, now = new Date()): string {
  const headers = [
    `From: ${sanitiseHeaderValue(from)}`,
    `To: ${sanitiseHeaderValue(message.to)}`,
    `Subject: ${sanitiseHeaderValue(message.subject)}`,
    `Date: ${rfc5322Date(now)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ]

  // SMTP is line-oriented and expects CRLF; a bare LF is tolerated by most
  // servers and mangled by some.
  const body = message.text.replace(/\r?\n/g, '\r\n')

  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`
}

/* -------------------------------------------------------------------------- */
/* Resend                                                                      */
/* -------------------------------------------------------------------------- */

const RESEND_URL = 'https://api.resend.com/emails'
const HTTP_TIMEOUT_MS = 10_000

export function createResendMailer(config: { apiKey: string; from: string }): Mailer {
  return {
    async send(message: EmailMessage): Promise<void> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

      try {
        const response = await fetch(RESEND_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: sanitiseHeaderValue(message.subject),
            text: message.text,
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = (await response.text().catch(() => '')).slice(0, 300)
          // The key never reaches a message that might be logged.
          const safe = body.replace(/re_[A-Za-z0-9_-]+/g, '[redacted]')
          throw new Error(`The email provider returned ${response.status}. ${safe}`.trim())
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* SMTP                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The minimal SMTP dialogue this application needs.
 *
 * Written against an injectable socket so the conversation can be tested
 * without a server: SMTP is a sequence of "send this, expect a code in that
 * range", and getting the sequence wrong is the whole failure mode.
 */
export interface SmtpSocket {
  write(data: string): Promise<void>
  /** Resolve with the next complete reply line group from the server. */
  readReply(): Promise<string>
  startTls(): Promise<void>
  close(): Promise<void>
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
    this.name = 'SmtpError'
  }
}

/** The reply code is the first three characters of the last line. */
export function replyCode(reply: string): number {
  const lines = reply.trim().split(/\r?\n/)
  const last = lines[lines.length - 1] ?? ''
  return Number.parseInt(last.slice(0, 3), 10)
}

async function expect(socket: SmtpSocket, accepted: number[], step: string): Promise<string> {
  const reply = await socket.readReply()
  const code = replyCode(reply)

  if (!accepted.includes(code)) {
    // The reply is included because an SMTP rejection reason is the only useful
    // diagnostic, and it contains no credential — the password is never echoed.
    throw new SmtpError(`SMTP ${step} failed: ${reply.trim().slice(0, 200)}`, code)
  }

  return reply
}

export interface SmtpDialogueOptions {
  host: string
  user: string
  password: string
  /** True when TLS is already established (implicit TLS, port 465). */
  secure: boolean
  from: string
  to: string
  message: string
}

/**
 * Run one SMTP conversation.
 *
 * Exported for the tests. STARTTLS is mandatory on a plaintext connection: a
 * password and a message body must not cross an unencrypted socket, so a server
 * that does not offer it is refused rather than downgraded to.
 */
export async function runSmtpDialogue(
  socket: SmtpSocket,
  options: SmtpDialogueOptions,
): Promise<void> {
  await expect(socket, [220], 'greeting')

  await socket.write(`EHLO ${options.host}\r\n`)
  let capabilities = await expect(socket, [250], 'EHLO')

  if (!options.secure) {
    if (!/STARTTLS/i.test(capabilities)) {
      throw new SmtpError(
        'The SMTP server does not offer STARTTLS. Refusing to send credentials in the clear.',
        0,
      )
    }

    await socket.write('STARTTLS\r\n')
    await expect(socket, [220], 'STARTTLS')
    await socket.startTls()

    // The dialogue restarts after the upgrade; capabilities before TLS are not
    // trustworthy and are discarded.
    await socket.write(`EHLO ${options.host}\r\n`)
    capabilities = await expect(socket, [250], 'EHLO after STARTTLS')
  }

  await socket.write('AUTH LOGIN\r\n')
  await expect(socket, [334], 'AUTH')
  await socket.write(`${Buffer.from(options.user, 'utf8').toString('base64')}\r\n`)
  await expect(socket, [334], 'AUTH username')
  await socket.write(`${Buffer.from(options.password, 'utf8').toString('base64')}\r\n`)
  await expect(socket, [235], 'AUTH password')

  await socket.write(`MAIL FROM:<${extractAddress(options.from)}>\r\n`)
  await expect(socket, [250], 'MAIL FROM')
  await socket.write(`RCPT TO:<${extractAddress(options.to)}>\r\n`)
  await expect(socket, [250, 251], 'RCPT TO')
  await socket.write('DATA\r\n')
  await expect(socket, [354], 'DATA')

  // Dot-stuffing: a line consisting of a single "." would otherwise terminate
  // the message early.
  const stuffed = options.message.replace(/^\./gm, '..')
  await socket.write(`${stuffed}\r\n.\r\n`)
  await expect(socket, [250], 'message body')

  await socket.write('QUIT\r\n')
}

/** `Name <addr@host>` → `addr@host`. */
export function extractAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value)
  return sanitiseHeaderValue(match?.[1] ?? value)
}

const SMTP_TIMEOUT_MS = 15_000

/**
 * A socket backed by `node:net` / `node:tls`.
 *
 * Imported dynamically so that neither module is pulled into a bundle that does
 * not send email — the edge runtime has neither.
 */
async function connectSmtpSocket(options: {
  host: string
  port: number
  secure: boolean
}): Promise<SmtpSocket> {
  const net = await import('node:net')
  const tls = await import('node:tls')

  let socket: Socket = options.secure
    ? tls.connect({ host: options.host, port: options.port, servername: options.host })
    : net.connect({ host: options.host, port: options.port })

  socket.setEncoding('utf8')
  socket.setTimeout(SMTP_TIMEOUT_MS)

  let buffer = ''
  let waiting: ((value: string) => void) | null = null
  let failure: Error | null = null
  let rejectWaiting: ((error: Error) => void) | null = null

  const attach = (target: Socket) => {
    target.on('data', (chunk: string) => {
      buffer += chunk
      // A reply is complete when the last line's fourth character is a space
      // rather than a hyphen — the multi-line continuation marker.
      if (/^\d{3} [^\n]*\r?\n$/m.test(buffer.split(/\r?\n/).slice(-2).join('\n') + '\n')) {
        const reply = buffer
        buffer = ''
        waiting?.(reply)
        waiting = null
        rejectWaiting = null
      }
    })
    target.on('error', (error: Error) => {
      failure = error
      rejectWaiting?.(error)
    })
    target.on('timeout', () => {
      const error = new SmtpError('The SMTP server did not respond in time.', 0)
      failure = error
      rejectWaiting?.(error)
      target.destroy()
    })
  }

  attach(socket)

  return {
    async write(data: string) {
      if (failure) throw failure
      await new Promise<void>((resolve, reject) => {
        socket.write(data, (error) => (error ? reject(error) : resolve()))
      })
    },

    async readReply() {
      if (failure) throw failure
      return new Promise<string>((resolve, reject) => {
        waiting = resolve
        rejectWaiting = reject
      })
    },

    async startTls() {
      const plain = socket
      plain.removeAllListeners('data')
      plain.removeAllListeners('error')
      plain.removeAllListeners('timeout')

      socket = tls.connect({ socket: plain, servername: options.host })
      socket.setEncoding('utf8')
      socket.setTimeout(SMTP_TIMEOUT_MS)
      buffer = ''
      attach(socket)

      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', () => resolve())
        socket.once('error', reject)
      })
    },

    async close() {
      socket.end()
    },
  }
}

export function createSmtpMailer(config: {
  host: string
  port: number
  user: string
  password: string
  secure: boolean
  from: string
}): Mailer {
  return {
    async send(message: EmailMessage): Promise<void> {
      const socket = await connectSmtpSocket({
        host: config.host,
        port: config.port,
        secure: config.secure,
      })

      try {
        await runSmtpDialogue(socket, {
          host: config.host,
          user: config.user,
          password: config.password,
          secure: config.secure,
          from: config.from,
          to: message.to,
          message: buildMimeMessage(message, config.from),
        })
      } finally {
        await socket.close().catch(() => {})
      }
    },
  }
}

/* -------------------------------------------------------------------------- */

/**
 * The transport selected by configuration.
 *
 * Returns null for the console transport so the caller keeps its existing
 * development behaviour rather than this module owning two responsibilities.
 */
export function createConfiguredMailer(): Mailer | null {
  const config = getEmailConfig()

  if (config.provider === 'resend') {
    return createResendMailer({ apiKey: config.apiKey, from: config.from })
  }

  if (config.provider === 'smtp') {
    return createSmtpMailer({ ...config.smtp, from: config.from })
  }

  return null
}
