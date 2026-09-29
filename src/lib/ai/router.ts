import { getAiConfig } from '@/kernel/config/env'

import { createAnthropicProvider } from './anthropic'
import type { LanguageModelProvider } from './types'

/**
 * The model router.
 *
 * Callers ask for a PURPOSE — "assistant", "summarize", "classify" — and never
 * for a model string. Three consequences:
 *
 * 1. Changing which model does what is one table, not a search-and-replace.
 * 2. A caller cannot accidentally send a cheap classification to an expensive
 *    model, or the reverse.
 * 3. Cost can be reasoned about per purpose, which is how anyone actually
 *    thinks about an AI budget.
 */

export type Purpose = 'assistant' | 'summarize' | 'classify' | 'narrate' | 'embed'

const DEFAULT_MODELS: Record<Purpose, string> = {
  assistant: 'claude-opus-5',
  summarize: 'claude-sonnet-5',
  classify: 'claude-haiku-4-5-20251001',
  narrate: 'claude-sonnet-5',
  embed: 'claude-sonnet-5',
}

export function modelFor(purpose: string): string {
  return DEFAULT_MODELS[purpose as Purpose] ?? DEFAULT_MODELS.summarize
}

export const PURPOSES = Object.keys(DEFAULT_MODELS) as Purpose[]

/* -------------------------------------------------------------------------- */
/* Provider resolution                                                         */
/* -------------------------------------------------------------------------- */

let cached: LanguageModelProvider | null | undefined
let override: LanguageModelProvider | undefined

/**
 * The configured provider, or null when none is configured.
 *
 * Returning null rather than throwing is deliberate: a deployment without an
 * API key is a legitimate state, and the product must say so plainly instead of
 * erroring. Everything that does not need a model — the insight engine, the
 * usage dashboard, the conversation history — keeps working.
 */
export function getProvider(): LanguageModelProvider | null {
  if (override) return override
  if (cached !== undefined) return cached

  const config = getAiConfig()

  cached = config.apiKey
    ? createAnthropicProvider({
        apiKey: config.apiKey,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      })
    : null

  return cached
}

export function isAiConfigured(): boolean {
  return getProvider() !== null
}

/** Test seam: install a fake provider so the layers above can be exercised. */
export function setProvider(provider: LanguageModelProvider | undefined): void {
  override = provider
  cached = undefined
}
