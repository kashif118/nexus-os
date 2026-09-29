import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LanguageModelProvider,
  Message,
  ProviderCapabilities,
  StreamPart,
  ToolCallPart,
  Usage,
} from './types'

/**
 * The Anthropic adapter.
 *
 * Plain `fetch` against the Messages API rather than an SDK: the transport is
 * about eighty lines, and a dependency here would put a vendor's types one
 * import away from leaking into the application — which is the exact thing the
 * provider abstraction exists to prevent.
 *
 * Every vendor concept stays inside this file. Above it, the application knows
 * only about purposes, messages and tool specs.
 *
 * NOTE ON VERIFICATION: this adapter has not been run against the live API in
 * this environment, because no API key was available and inventing one was not
 * an option. The request and response shapes follow the documented Messages
 * API, the translation in both directions is unit-tested against recorded
 * shapes, and everything above the adapter is exercised with a fake provider.
 * Recorded in docs/ROADMAP.md §U.
 */

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

/**
 * Prices in micros of USD per million tokens, for cost metering.
 *
 * A table rather than a live lookup: a cost estimate that depends on a network
 * call is a cost estimate that fails open. Figures are approximate and are
 * labelled as estimates wherever they are shown.
 */
const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-opus-5': { inputPerMillion: 15_000_000, outputPerMillion: 75_000_000 },
  'claude-sonnet-5': { inputPerMillion: 3_000_000, outputPerMillion: 15_000_000 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 800_000, outputPerMillion: 4_000_000 },
}

const DEFAULT_PRICING = { inputPerMillion: 3_000_000, outputPerMillion: 15_000_000 }

export interface AnthropicConfig {
  apiKey: string
  baseUrl?: string
}

/**
 * Retry policy.
 *
 * A model provider returns 429 when you are over its rate limit and 529 when it
 * is overloaded, and both are routinely transient. Failing the user's request
 * on the first one wastes a retry the provider is explicitly inviting.
 *
 * Bounded deliberately: two retries, and only on statuses that say "try again".
 * A 400 is a bug in the request and retrying it just costs time; a 401 is a bad
 * key and retrying it is how you get a key locked.
 *
 * The total wait is capped so that retrying cannot exceed the request timeout
 * the caller asked for — a retry that outlives its own deadline is worse than
 * no retry, because the user has already gone.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000

/** Honour `retry-after` when the provider sends one, else exponential backoff. */
export function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS)
    }
  }

  // Full jitter. Without it, every caller that hit the same rate limit retries
  // in lockstep and hits it again together.
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return Math.round(Math.random() * ceiling)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createAnthropicProvider(config: AnthropicConfig): LanguageModelProvider {
  const url = config.baseUrl ?? API_URL

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    'anthropic-version': API_VERSION,
    'x-api-key': config.apiKey,
  })

  const body = (request: GenerateRequest, model: string, stream: boolean) =>
    JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? 2048,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      system: request.system,
      messages: toVendorMessages(request.messages),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      ...(stream ? { stream: true } : {}),
    })

  return {
    id: 'anthropic',

    capabilities(): ProviderCapabilities {
      return { tools: true, streaming: true, vision: true, embeddings: false, maxContext: 200_000 }
    },

    estimateCostMicros(usage: Usage, model: string): number {
      const pricing = PRICING[model] ?? DEFAULT_PRICING
      // Integer arithmetic throughout: cost is money, and money is not a float.
      const input = Math.round((usage.promptTokens * pricing.inputPerMillion) / 1_000_000)
      const output = Math.round((usage.completionTokens * pricing.outputPerMillion) / 1_000_000)
      return input + output
    },

    async generate(request, model) {
      const budgetMs = request.timeoutMs ?? 60_000
      const deadline = Date.now() + budgetMs

      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController()
        const remaining = Math.max(deadline - Date.now(), 1)
        const timeout = setTimeout(() => controller.abort(), remaining)

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: headers(),
            body: body(request, model, false),
            signal: controller.signal,
          })

          if (response.ok) {
            return parseGenerateResponse((await response.json()) as VendorResponse, model)
          }

          const retryable = RETRYABLE_STATUSES.has(response.status)
          const delay = retryDelayMs(attempt, response.headers.get('retry-after'))

          // Only retry when there is both an invitation to and time left to.
          if (!retryable || attempt >= MAX_ATTEMPTS - 1 || Date.now() + delay >= deadline) {
            throw new Error(await describeFailure(response))
          }

          await sleep(delay)
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            // Otherwise this surfaces as a bare "The operation was aborted",
            // which tells a user nothing and a developer almost nothing.
            throw new Error(
              `The model provider did not respond within ${Math.round(budgetMs / 1000)} seconds.`,
            )
          }
          throw error
        } finally {
          clearTimeout(timeout)
        }
      }
    },

    async *stream(request, model): AsyncIterable<StreamPart> {
      const budgetMs = request.timeoutMs ?? 120_000
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), budgetMs)

      try {
        let response: Response
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: headers(),
            body: body(request, model, true),
            signal: controller.signal,
          })
        } catch (error) {
          // A stream reports failure as a part rather than throwing, because the
          // consumer is a loop that has already started rendering.
          yield {
            type: 'error',
            message:
              error instanceof Error && error.name === 'AbortError'
                ? `The model provider did not respond within ${Math.round(budgetMs / 1000)} seconds.`
                : 'The model provider could not be reached.',
          }
          return
        }

        if (!response.ok || !response.body) {
          yield { type: 'error', message: await describeFailure(response) }
          return
        }

        yield* parseEventStream(response.body, model)
      } finally {
        clearTimeout(timeout)
      }
    },

    async embed(_request: EmbedRequest): Promise<EmbedResult> {
      // Anthropic has no embeddings endpoint. Saying so is better than
      // returning a plausible-looking zero vector that would silently break
      // every similarity search built on it.
      throw new Error('This provider does not offer embeddings.')
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Translation                                                                 */
/* -------------------------------------------------------------------------- */

interface VendorResponse {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >
  usage?: { input_tokens?: number; output_tokens?: number }
  stop_reason?: string
  model?: string
}

/** Our messages → the vendor's. Exported for the translation tests. */
export function toVendorMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      // A tool result is carried on a user turn in this API.
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        if (part.type === 'tool_call') {
          return { type: 'tool_use', id: part.id, name: part.name, input: part.arguments }
        }
        return {
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        }
      }),
    }))
}

export function parseGenerateResponse(response: VendorResponse, model: string): GenerateResult {
  const parts = response.content ?? []

  const toolCalls: ToolCallPart[] = parts
    .filter((part): part is Extract<typeof part, { type: 'tool_use' }> => part.type === 'tool_use')
    .map((part) => ({
      type: 'tool_call',
      id: part.id,
      name: part.name,
      arguments: part.input ?? {},
    }))

  return {
    text: parts
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join(''),
    toolCalls,
    usage: {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
    },
    model: response.model ?? model,
    finishReason: response.stop_reason ?? 'stop',
  }
}

/**
 * Server-sent events → our stream parts.
 *
 * Exported and written against a `ReadableStream` so it can be tested from a
 * string without a network: streaming parsers are where transport bugs hide.
 */
export async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
  model: string,
): AsyncIterable<StreamPart> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  const usage: Usage = { promptTokens: 0, completionTokens: 0 }
  let finishReason = 'stop'

  const toolCalls = new Map<number, { id: string; name: string; json: string }>()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data:')) continue

        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(payload) as Record<string, unknown>
        } catch {
          continue
        }

        const type = typeof event.type === 'string' ? event.type : ''

        if (type === 'content_block_start') {
          const block = event.content_block as
            { type?: string; id?: string; name?: string } | undefined
          if (block?.type === 'tool_use') {
            toolCalls.set(Number(event.index ?? 0), {
              id: block.id ?? '',
              name: block.name ?? '',
              json: '',
            })
          }
          continue
        }

        if (type === 'content_block_delta') {
          const delta = event.delta as { type?: string; text?: string; partial_json?: string }

          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text-delta', text: delta.text }
          }

          if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
            const entry = toolCalls.get(Number(event.index ?? 0))
            if (entry) entry.json += delta.partial_json
          }
          continue
        }

        if (type === 'content_block_stop') {
          const entry = toolCalls.get(Number(event.index ?? 0))
          if (entry) {
            toolCalls.delete(Number(event.index ?? 0))
            let args: Record<string, unknown> = {}
            try {
              args =
                entry.json.length > 0 ? (JSON.parse(entry.json) as Record<string, unknown>) : {}
            } catch {
              // A tool call whose arguments did not parse is reported as an
              // error rather than invoked with a guess.
              yield { type: 'error', message: `Tool "${entry.name}" sent unreadable arguments.` }
              continue
            }
            yield {
              type: 'tool-call',
              call: { type: 'tool_call', id: entry.id, name: entry.name, arguments: args },
            }
          }
          continue
        }

        if (type === 'message_delta') {
          const delta = event.delta as { stop_reason?: string } | undefined
          const usageDelta = event.usage as { output_tokens?: number } | undefined
          if (delta?.stop_reason) finishReason = delta.stop_reason
          if (usageDelta?.output_tokens) usage.completionTokens = usageDelta.output_tokens
          continue
        }

        if (type === 'message_start') {
          const message = event.message as
            { usage?: { input_tokens?: number }; model?: string } | undefined
          usage.promptTokens = message?.usage?.input_tokens ?? 0
          continue
        }

        if (type === 'error') {
          const error = event.error as { message?: string } | undefined
          yield { type: 'error', message: error?.message ?? 'The model stream failed.' }
          return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  yield { type: 'finish', usage, model, finishReason }
}

/**
 * A failure message that never echoes the key.
 *
 * Provider errors are shown to developers and sometimes to users, and an error
 * body can contain the request that caused it.
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    detail = body.error?.message ?? ''
  } catch {
    detail = ''
  }

  const safe = detail.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)
  return `The model provider returned ${response.status}${safe ? `: ${safe}` : '.'}`
}
