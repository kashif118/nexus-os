/**
 * Our own message and tool types.
 *
 * Deliberately not a vendor's types. Every adapter translates to and from these
 * shapes, which is what makes the provider swappable in more than name: if the
 * application spoke Anthropic's message format, "add OpenAI" would mean editing
 * every call site rather than writing one adapter.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolCallPart {
  type: 'tool_call'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResultPart {
  type: 'tool_result'
  toolCallId: string
  /** Serialised result. Already redacted and already authorized. */
  content: string
  isError?: boolean
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart

export interface Message {
  role: Role
  content: ContentPart[]
}

/** A tool as the model sees it: a name, a description and a JSON schema. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface GenerateRequest {
  /** A purpose, never a model string: the router decides which model runs. */
  purpose: string
  system: string
  messages: Message[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  /** Abort budget in milliseconds. */
  timeoutMs?: number
}

export interface Usage {
  promptTokens: number
  completionTokens: number
}

export interface GenerateResult {
  text: string
  toolCalls: ToolCallPart[]
  usage: Usage
  model: string
  /** Why the model stopped: "stop" | "tool_use" | "length" | "refusal". */
  finishReason: string
}

export type StreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallPart }
  | { type: 'finish'; usage: Usage; model: string; finishReason: string }
  | { type: 'error'; message: string }

export interface EmbedRequest {
  purpose: string
  input: string[]
}

export interface EmbedResult {
  vectors: number[][]
  usage: Usage
  model: string
}

export interface ProviderCapabilities {
  tools: boolean
  streaming: boolean
  vision: boolean
  embeddings: boolean
  maxContext: number
}

export interface LanguageModelProvider {
  readonly id: string
  generate(request: GenerateRequest, model: string): Promise<GenerateResult>
  stream(request: GenerateRequest, model: string): AsyncIterable<StreamPart>
  embed(request: EmbedRequest, model: string): Promise<EmbedResult>
  capabilities(): ProviderCapabilities
  /** Cost in MICROS of USD. Integer arithmetic, as with every other money path. */
  estimateCostMicros(usage: Usage, model: string): number
}

/** Convenience constructors, so call sites do not build part arrays by hand. */
export const text = (value: string): TextPart => ({ type: 'text', text: value })

export const userMessage = (value: string): Message => ({ role: 'user', content: [text(value)] })

export const assistantMessage = (value: string): Message => ({
  role: 'assistant',
  content: [text(value)],
})

/** Flatten a message's text parts, ignoring tool traffic. */
export function messageText(message: Message): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}
