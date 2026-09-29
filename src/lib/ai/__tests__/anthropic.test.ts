import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createAnthropicProvider,
  parseEventStream,
  parseGenerateResponse,
  retryDelayMs,
  toVendorMessages,
} from '../anthropic'
import type { GenerateRequest } from '../types'

/**
 * The Anthropic transport.
 *
 * BLOCKED, and stated plainly: none of this has run against the live API, because
 * no key was available. What is tested here is everything that does not need one —
 * the translation in both directions, the streaming parser, and the failure
 * handling, which is the part that decides whether a rate limit becomes a retry
 * or an error in front of a user.
 *
 * `fetch` is stubbed. That proves the adapter does the right thing with a given
 * response; it does not prove the response shape matches what Anthropic actually
 * sends. The first real call is still the first real call.
 */

const KEY = 'sk-ant-test-key-that-is-long-enough-to-pass'

const request: GenerateRequest = {
  purpose: 'test',
  system: 'You are a test.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const okBody = {
  content: [{ type: 'text', text: 'Hi there' }],
  usage: { input_tokens: 10, output_tokens: 4 },
  stop_reason: 'end_turn',
  model: 'claude-sonnet-5',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('retryDelayMs', () => {
  it('honours a retry-after header in seconds', () => {
    expect(retryDelayMs(0, '2')).toBe(2000)
  })

  it('caps a retry-after that would outlast any request', () => {
    expect(retryDelayMs(0, '3600')).toBeLessThanOrEqual(8000)
  })

  it('falls back to bounded jittered backoff', () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const delay = retryDelayMs(attempt, null)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(8000)
    }
  })

  it('ignores a retry-after that is not a number', () => {
    // Stripe and others sometimes send an HTTP-date here. Parsing it wrongly as
    // NaN and waiting NaN milliseconds would hang the request.
    const delay = retryDelayMs(0, 'Wed, 21 Oct 2026 07:28:00 GMT')
    expect(Number.isFinite(delay)).toBe(true)
    expect(delay).toBeLessThanOrEqual(8000)
  })
})

describe('generate', () => {
  it('sends the key as a header and never in the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(okBody))

    const provider = createAnthropicProvider({ apiKey: KEY })
    await provider.generate(request, 'claude-sonnet-5')

    const [, init] = fetchSpy.mock.calls[0]!
    const headers = (init as RequestInit).headers as Record<string, string>

    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['anthropic-version']).toBeTruthy()
    expect(String((init as RequestInit).body)).not.toContain(KEY)
  })

  it('retries a rate limit and succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }),
      )
      .mockResolvedValueOnce(jsonResponse(okBody))

    const provider = createAnthropicProvider({ apiKey: KEY })
    const result = await provider.generate(request, 'claude-sonnet-5')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('Hi there')
  })

  it('retries an overloaded provider', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'overloaded' } }, 529))
      .mockResolvedValueOnce(jsonResponse(okBody))

    const provider = createAnthropicProvider({ apiKey: KEY })
    await provider.generate(request, 'claude-sonnet-5')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a bad request', async () => {
    // A 400 is a bug in what we sent. Retrying it burns the user's time and
    // changes nothing.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ error: { message: 'bad request' } }, 400))

    const provider = createAnthropicProvider({ apiKey: KEY })

    await expect(provider.generate(request, 'claude-sonnet-5')).rejects.toThrow('400')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry an authentication failure', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ error: { message: 'invalid x-api-key' } }, 401))

    const provider = createAnthropicProvider({ apiKey: KEY })

    await expect(provider.generate(request, 'claude-sonnet-5')).rejects.toThrow('401')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('gives up after a bounded number of attempts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'still limited' } }, 429, {
        'retry-after': '0',
      }),
    )

    const provider = createAnthropicProvider({ apiKey: KEY })

    await expect(provider.generate(request, 'claude-sonnet-5')).rejects.toThrow('429')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('stops retrying rather than outliving its own deadline', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ error: { message: 'limited' } }, 429, { 'retry-after': '5' }),
      )

    const provider = createAnthropicProvider({ apiKey: KEY })

    // A five-second backoff does not fit inside a one-second budget, so the
    // adapter must fail now rather than wait past the point anyone is listening.
    await expect(
      provider.generate({ ...request, timeoutMs: 1000 }, 'claude-sonnet-5'),
    ).rejects.toThrow('429')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reports a timeout in words rather than as an abort', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          ;(init as RequestInit).signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )

    const provider = createAnthropicProvider({ apiKey: KEY })

    await expect(
      provider.generate({ ...request, timeoutMs: 10 }, 'claude-sonnet-5'),
    ).rejects.toThrow(/did not respond within/)
  })

  it('never echoes a key back in an error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: `invalid key sk-ant-secret-value-here` } }, 401),
    )

    const provider = createAnthropicProvider({ apiKey: KEY })

    await expect(provider.generate(request, 'claude-sonnet-5')).rejects.toThrow(/\[redacted\]/)
  })
})

describe('cost estimation', () => {
  it('is integer arithmetic, because cost is money', () => {
    const provider = createAnthropicProvider({ apiKey: KEY })
    const micros = provider.estimateCostMicros(
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      'claude-sonnet-5',
    )

    expect(Number.isInteger(micros)).toBe(true)
    expect(micros).toBe(3_000_000 + 15_000_000)
  })

  it('falls back to a known rate for an unknown model rather than zero', () => {
    const provider = createAnthropicProvider({ apiKey: KEY })
    const micros = provider.estimateCostMicros(
      { promptTokens: 1_000, completionTokens: 1_000 },
      'some-future-model',
    )

    // Zero would mean an unknown model silently consumes no budget.
    expect(micros).toBeGreaterThan(0)
  })
})

describe('translation', () => {
  it('drops system turns, which travel in their own field', () => {
    const vendor = toVendorMessages([
      { role: 'system', content: [{ type: 'text', text: 'ignored' }] },
      { role: 'user', content: [{ type: 'text', text: 'kept' }] },
    ])

    expect(vendor).toHaveLength(1)
    expect(vendor[0]!.role).toBe('user')
  })

  it('carries a tool result on a user turn', () => {
    const vendor = toVendorMessages([
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'done', isError: false }],
      },
    ])

    expect(vendor[0]!.role).toBe('user')
    const parts = vendor[0]!.content as Array<Record<string, unknown>>
    expect(parts[0]!.type).toBe('tool_result')
    expect(parts[0]!.tool_use_id).toBe('call_1')
  })

  it('reads text and tool calls out of a response', () => {
    const result = parseGenerateResponse(
      {
        content: [
          { type: 'text', text: 'Looking that up. ' },
          { type: 'tool_use', id: 'call_9', name: 'listProjects', input: { limit: 5 } },
        ],
        usage: { input_tokens: 7, output_tokens: 3 },
        stop_reason: 'tool_use',
      },
      'claude-sonnet-5',
    )

    expect(result.text).toBe('Looking that up. ')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.name).toBe('listProjects')
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3 })
  })

  it('survives a response with no usage block', () => {
    const result = parseGenerateResponse({ content: [] }, 'claude-sonnet-5')
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 })
  })
})

describe('the streaming parser', () => {
  const streamOf = (events: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const event of events) controller.enqueue(encoder.encode(event))
        controller.close()
      },
    })

  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const parts = []
    for await (const part of parseEventStream(stream, 'claude-sonnet-5')) parts.push(part)
    return parts
  }

  it('assembles text deltas and a final usage report', async () => {
    const parts = await collect(
      streamOf([
        `data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n`,
      ]),
    )

    const text = parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => (part as { text: string }).text)
      .join('')

    expect(text).toBe('Hello')

    const finish = parts.at(-1) as { type: string; usage: { promptTokens: number } }
    expect(finish.type).toBe('finish')
    expect(finish.usage.promptTokens).toBe(12)
  })

  it('reassembles a tool call split across chunks', async () => {
    // The argument JSON arrives in fragments, and a fragment is not valid JSON.
    const parts = await collect(
      streamOf([
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"createTask"}}\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"title\\":"}}\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Ship it\\"}"}}\n`,
        `data: {"type":"content_block_stop","index":0}\n`,
      ]),
    )

    const call = parts.find((part) => part.type === 'tool-call') as {
      call: { name: string; arguments: Record<string, unknown> }
    }

    expect(call.call.name).toBe('createTask')
    expect(call.call.arguments).toEqual({ title: 'Ship it' })
  })

  it('reports unreadable tool arguments rather than invoking a guess', async () => {
    const parts = await collect(
      streamOf([
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"deleteProject"}}\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not json"}}\n`,
        `data: {"type":"content_block_stop","index":0}\n`,
      ]),
    )

    expect(parts.some((part) => part.type === 'tool-call')).toBe(false)
    expect(parts.some((part) => part.type === 'error')).toBe(true)
  })

  it('ignores a malformed line instead of failing the stream', async () => {
    const parts = await collect(
      streamOf([
        `data: not-json\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n`,
      ]),
    )

    expect(parts.some((part) => part.type === 'text-delta')).toBe(true)
  })

  it('stops on a provider error event', async () => {
    const parts = await collect(
      streamOf([`data: {"type":"error","error":{"message":"overloaded"}}\n`]),
    )

    expect(parts).toHaveLength(1)
    expect(parts[0]!.type).toBe('error')
  })
})
