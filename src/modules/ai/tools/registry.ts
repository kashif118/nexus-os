import type { z } from 'zod'

import type { Permission } from '@/kernel/authz/catalogue'
import type { Ctx } from '@/kernel/tenancy/ctx'
import { redactObject } from '@/lib/ai/redact'
import type { ToolSpec } from '@/lib/ai/types'

/**
 * The AI tool layer (docs/AI-AND-AUTOMATION.md §J.5).
 *
 * The single most important property of this file: **the model never queries
 * the database.** It asks for a tool by name; the tool calls a service; the
 * service enforces authorization with the CALLER's context. There is no
 * privileged path — an assistant run has strictly at most the permissions of
 * the person who started it, and an attacker who successfully injects
 * instructions into the prompt gains exactly nothing, because the injection
 * cannot grant a permission.
 *
 * Three enforcement points, in order:
 *
 * 1. **Before invocation** — the declared permissions are checked against the
 *    caller. A tool the caller may not use is not offered to the model at all,
 *    and is refused again if it is somehow called.
 * 2. **Inside the handler** — the service checks again, because a tool is not
 *    trusted to be the only guard.
 * 3. **After invocation** — the result is redacted field-by-field before it is
 *    serialised into the prompt, so a readable record still cannot leak a pay
 *    rate or a storage key.
 */

export interface ToolDefinition<TArgs = unknown> {
  name: string
  description: string
  parameters: z.ZodType<TArgs>
  /** JSON Schema the model is shown. Kept beside the Zod schema deliberately. */
  jsonSchema: Record<string, unknown>
  /** ALL of these are required. An empty list means any member may use it. */
  requiredPermissions: Permission[]
  sideEffect: 'read' | 'write' | 'external'
  handler(ctx: Ctx, args: TArgs): Promise<unknown>
}

const TOOLS = new Map<string, ToolDefinition<never>>()

export function defineTool<TArgs>(definition: ToolDefinition<TArgs>): void {
  if (TOOLS.has(definition.name)) {
    throw new Error(`Duplicate AI tool: ${definition.name}`)
  }
  TOOLS.set(definition.name, definition as ToolDefinition<never>)
}

export const getTool = (name: string): ToolDefinition<never> | undefined => TOOLS.get(name)

export const listTools = (): Array<ToolDefinition<never>> => [...TOOLS.values()]

/** Test seam. */
export function resetTools(): void {
  TOOLS.clear()
}

/**
 * The tools this caller may use, as the model sees them.
 *
 * Filtering here rather than refusing later matters for behaviour as well as
 * security: a model shown a tool it cannot use will try it, fail, and often
 * apologise its way through several turns. Not offering it produces a better
 * answer AND a cheaper one.
 */
export function toolSpecsFor(ctx: Ctx, options: { allowWrites?: boolean } = {}): ToolSpec[] {
  return listTools()
    .filter((tool) => (options.allowWrites ? true : tool.sideEffect === 'read'))
    .filter((tool) => tool.requiredPermissions.every((permission) => ctx.can(permission)))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    }))
}

export interface ToolOutcome {
  ok: boolean
  /** Serialised for the prompt: already authorized, already redacted. */
  content: string
}

/**
 * Run one tool call.
 *
 * Never throws for an expected failure. A refusal or a validation error is
 * returned to the model as a tool result so it can adjust — an exception would
 * abort the turn and lose the conversation, which is a worse outcome for a case
 * the model can usually recover from.
 */
export async function invokeTool(
  ctx: Ctx,
  name: string,
  rawArgs: unknown,
  options: { allowWrites?: boolean } = {},
): Promise<ToolOutcome> {
  const tool = getTool(name)

  if (!tool) {
    return { ok: false, content: `No tool named "${name}" exists.` }
  }

  if (tool.sideEffect !== 'read' && !options.allowWrites) {
    return {
      ok: false,
      content: `"${name}" changes data and is not available in this session.`,
    }
  }

  const missing = tool.requiredPermissions.filter((permission) => !ctx.can(permission))
  if (missing.length > 0) {
    // The model is told it may not, without being told what the data would have
    // been — the refusal itself must not become an oracle.
    return { ok: false, content: `You do not have permission to use "${name}".` }
  }

  const parsed = tool.parameters.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      content: `Those arguments are not valid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'argument'} ${issue.message}`)
        .join('; ')}`,
    }
  }

  try {
    const result = await tool.handler(ctx, parsed.data as never)
    return { ok: true, content: serialise(redactObject(result)) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The tool failed.'
    return { ok: false, content: message.slice(0, 300) }
  }
}

/**
 * Serialise a tool result for the prompt.
 *
 * `bigint` needs a replacer — money is stored in minor units as bigint, and
 * `JSON.stringify` throws on it rather than choosing a representation. Dates
 * become plain days, which is what a model should reason about.
 */
export function serialise(value: unknown): string {
  const json = JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (typeof entry === 'bigint') return entry.toString()
      return entry
    },
    0,
  )

  // A tool that returns an enormous result would crowd out the conversation, so
  // it is truncated with a note rather than silently cut.
  const LIMIT = 12_000
  if (json && json.length > LIMIT) {
    return `${json.slice(0, LIMIT)}\n… truncated. Narrow the query and ask again.`
  }

  return json ?? 'null'
}
