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
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000)

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: headers(),
          body: body(request, model, false),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(await describeFailure(response))
        }

        return parseGenerateResponse((await response.json()) as VendorResponse, model)
      } finally {
        clearTimeout(timeout)
      }
    },

    async *stream(request, model): AsyncIterable<StreamPart> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000)

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: headers(),
          body: body(request, model, true),
          signal: controller.signal,
        })

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
