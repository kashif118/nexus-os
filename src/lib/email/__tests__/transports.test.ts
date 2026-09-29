import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildMimeMessage,
  createResendMailer,
  extractAddress,
  replyCode,
  runSmtpDialogue,
  sanitiseHeaderValue,
  SmtpError,
  type SmtpSocket,
} from '../transports'

/**
 * The email transports.
 *
 * BLOCKED on live verification: no SMTP server and no Resend key were available,
 * so neither has sent a real message. What is covered is everything that can be:
 * the message this application constructs, and the conversation it has.
 *
 * The SMTP dialogue is tested against a scripted socket. That is not a
 * substitute for a real server — servers differ in what they announce and what
 * they tolerate — but the sequence is where the failures are, and the sequence
 * is deterministic.
 */

/** A socket that replies from a script and records what was written. */
function scriptedSocket(replies: string[]) {
  const written: string[] = []
  let index = 0
  let tlsStarted = false

  const socket: SmtpSocket = {
    async write(data) {
      written.push(data)
    },
    async readReply() {
      const reply = replies[index]
      index += 1
      if (reply === undefined) throw new Error('The script ran out of replies.')
      return reply
    },
    async startTls() {
      tlsStarted = true
    },
    async close() {},
  }

  return { socket, written, tls: () => tlsStarted }
}

const OK = {
  greeting: '220 mail.example.com ESMTP\r\n',
  ehlo: '250-mail.example.com\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n',
  ehloNoTls: '250-mail.example.com\r\n250 AUTH LOGIN PLAIN\r\n',
  starttls: '220 Ready to start TLS\r\n',
  authPrompt: '334 VXNlcm5hbWU6\r\n',
  authOk: '235 Authentication succeeded\r\n',
  mailFrom: '250 OK\r\n',
  rcptTo: '250 Accepted\r\n',
  data: '354 End data with <CR><LF>.<CR><LF>\r\n',
  accepted: '250 OK id=1\r\n',
}

const fullScript = [
  OK.greeting,
  OK.ehlo,
  OK.starttls,
  OK.ehlo,
  OK.authPrompt,
  OK.authPrompt,
  OK.authOk,
  OK.mailFrom,
  OK.rcptTo,
  OK.data,
  OK.accepted,
]

const options = {
  host: 'mail.example.com',
  user: 'postmaster@example.com',
  password: 'a-password',
  secure: false,
  from: 'NEXUS OS <no-reply@example.com>',
  to: 'someone@example.test',
  message: 'From: a\r\nTo: b\r\n\r\nbody\r\n',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('header handling', () => {
  it('strips line breaks that could inject another header', () => {
    // The abuse: a subject that smuggles in a Bcc. Organization names reach
    // subject lines, so this is reachable from user-supplied data.
    const value = sanitiseHeaderValue('Invoice ready\r\nBcc: attacker@example.test')

    expect(value).not.toContain('\r')
    expect(value).not.toContain('\n')
    expect(value).toBe('Invoice ready Bcc: attacker@example.test')
  })

  it('builds a message with the headers a relay expects', () => {
    const mime = buildMimeMessage(
      { to: 'someone@example.test', subject: 'Confirm your email', text: 'Line one\nLine two' },
      'NEXUS OS <no-reply@example.com>',
      new Date('2026-09-29T12:00:00Z'),
    )

    expect(mime).toContain('From: NEXUS OS <no-reply@example.com>')
    expect(mime).toContain('To: someone@example.test')
    expect(mime).toContain('Subject: Confirm your email')
    expect(mime).toContain('Date: ')
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8')
    // The body is CRLF, as SMTP requires.
    expect(mime).toContain('Line one\r\nLine two')
  })

  it('reads the address out of a display-name form', () => {
    expect(extractAddress('NEXUS OS <no-reply@example.com>')).toBe('no-reply@example.com')
    expect(extractAddress('plain@example.com')).toBe('plain@example.com')
  })
})

describe('reply parsing', () => {
  it('reads the code from the last line of a multi-line reply', () => {
    expect(replyCode(OK.ehlo)).toBe(250)
    expect(replyCode('550 No such user\r\n')).toBe(550)
  })
})

describe('the SMTP dialogue', () => {
  it('upgrades to TLS, authenticates and sends', async () => {
    const { socket, written, tls } = scriptedSocket(fullScript)

    await runSmtpDialogue(socket, options)

    expect(tls()).toBe(true)

    const conversation = written.join('')
    expect(conversation).toContain('EHLO mail.example.com')
    expect(conversation).toContain('STARTTLS')
    expect(conversation).toContain('AUTH LOGIN')
    expect(conversation).toContain('MAIL FROM:<no-reply@example.com>')
    expect(conversation).toContain('RCPT TO:<someone@example.test>')
    expect(conversation).toContain('QUIT')

    // Credentials are base64, which is encoding rather than protection — which
    // is exactly why the plaintext connection is upgraded first.
    expect(conversation).toContain(Buffer.from(options.user).toString('base64'))
    expect(conversation).not.toContain(options.password)
  })

  it('refuses to send credentials to a server with no STARTTLS', async () => {
    const { socket, written } = scriptedSocket([OK.greeting, OK.ehloNoTls])

    await expect(runSmtpDialogue(socket, options)).rejects.toThrow(/STARTTLS/)

    // And nothing resembling a credential was written.
    const conversation = written.join('')
    expect(conversation).not.toContain('AUTH')
    expect(conversation).not.toContain(Buffer.from(options.password).toString('base64'))
  })

  it('skips STARTTLS when the connection is already encrypted', async () => {
    const { socket, written, tls } = scriptedSocket([
      OK.greeting,
      OK.ehloNoTls,
      OK.authPrompt,
      OK.authPrompt,
      OK.authOk,
      OK.mailFrom,
      OK.rcptTo,
      OK.data,
      OK.accepted,
    ])

    await runSmtpDialogue(socket, { ...options, secure: true })

    expect(tls()).toBe(false)
    expect(written.join('')).not.toContain('STARTTLS')
  })

  it('reports an authentication failure with the server reason', async () => {
    const { socket } = scriptedSocket([
      OK.greeting,
      OK.ehlo,
      OK.starttls,
      OK.ehlo,
      OK.authPrompt,
      OK.authPrompt,
      '535 Authentication credentials invalid\r\n',
    ])

    await expect(runSmtpDialogue(socket, options)).rejects.toThrow(SmtpError)
    await expect(
      runSmtpDialogue(
        scriptedSocket([
          OK.greeting,
          OK.ehlo,
          OK.starttls,
          OK.ehlo,
          OK.authPrompt,
          OK.authPrompt,
          '535 Authentication credentials invalid\r\n',
        ]).socket,
        options,
      ),
    ).rejects.toThrow(/credentials invalid/)
  })

  it('reports a rejected recipient rather than reporting success', async () => {
    const { socket } = scriptedSocket([
      OK.greeting,
      OK.ehlo,
      OK.starttls,
      OK.ehlo,
      OK.authPrompt,
      OK.authPrompt,
      OK.authOk,
      OK.mailFrom,
      '550 No such recipient\r\n',
    ])

    await expect(runSmtpDialogue(socket, options)).rejects.toThrow(/RCPT TO/)
  })

  it('dot-stuffs a body line that would otherwise end the message early', async () => {
    const { socket, written } = scriptedSocket(fullScript)

    await runSmtpDialogue(socket, {
      ...options,
      message: 'Subject: x\r\n\r\nbefore\r\n.\r\nafter\r\n',
    })

    const body = written.join('')
    expect(body).toContain('\r\n..\r\n')
  })
})

describe('the Resend transport', () => {
  it('posts the message and does not put the key in the body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'x' }), { status: 200 }))

    const mailer = createResendMailer({ apiKey: 're_secret_key', from: 'a@example.com' })
    await mailer.send({ to: 'b@example.test', subject: 'Hello', text: 'Body' })

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('resend.com')

    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toContain('re_secret_key')
    expect(String((init as RequestInit).body)).not.toContain('re_secret_key')
  })

  it('throws on a rejection, so a failed send is never reported as sent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"domain not verified"}', { status: 403 }),
    )

    const mailer = createResendMailer({ apiKey: 're_secret_key', from: 'a@example.com' })

    await expect(
      mailer.send({ to: 'b@example.test', subject: 'Hello', text: 'Body' }),
    ).rejects.toThrow(/403/)
  })

  it('redacts a key echoed back in an error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"bad key re_leaked_value"}', { status: 401 }),
    )

    const mailer = createResendMailer({ apiKey: 're_secret_key', from: 'a@example.com' })

    await expect(
      mailer.send({ to: 'b@example.test', subject: 'Hello', text: 'Body' }),
    ).rejects.toThrow(/\[redacted\]/)
  })
})
