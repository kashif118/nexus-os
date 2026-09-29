import type { z } from 'zod'

import type { Permission } from '@/kernel/authz/catalogue'
import type { EventType } from '@/kernel/events'
import type { Ctx } from '@/kernel/tenancy/ctx'

import type { FieldMap } from './conditions'

/**
 * The trigger and action registries — the extensibility mechanism
 * (docs/AI-AND-AUTOMATION.md §L.2).
 *
 * The point of a registry rather than a switch statement is that adding an
 * automation capability is one entry, and the builder UI, the validator and the
 * condition field picker are all generated from it. Nothing about the engine
 * changes to ship a new action.
 *
 * The properties that matter:
 *
 * - **Every action declares the permissions it needs.** The engine intersects
 *   those with what the workflow's OWNER holds, so a workflow can never do more
 *   than the person who owns it. An owner who loses a permission stops that
 *   workflow's actions, rather than leaving an automation running with rights
 *   its owner no longer has.
 * - **Every action declares whether it is idempotent.** The engine replays
 *   steps after a crash; an action that is not safe to repeat is skipped rather
 *   than retried.
 * - **Triggers declare their fields.** That list is the ONLY thing a condition
 *   can read, which is what makes the interpreter safe.
 */

export interface FieldDescriptor {
  path: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'money'
  /** Allowed values, for an enum field: the builder renders a select. */
  options?: readonly string[]
}

export interface TriggerDefinition {
  type: string
  label: string
  description: string
  entityType: string
  /** Outbox events that fire this trigger. */
  eventTypes: EventType[]
  fields: FieldDescriptor[]
  /** Project the event payload onto the flat, allowlisted condition map. */
  toFields(payload: Record<string, unknown>): FieldMap
}

export interface ActionContext {
  /** Derived from the workflow owner; never from whoever caused the event. */
  ctx: Ctx
  runId: string
  /** Everything the run has accumulated: trigger fields plus earlier outputs. */
  data: Record<string, unknown>
  /** True in a test run: side effects are described, not performed. */
  dryRun: boolean
}

export interface ActionDefinition<TConfig = Record<string, unknown>> {
  type: string
  label: string
  description: string
  category: 'Work' | 'Communication' | 'Records' | 'AI' | 'Integration'
  configSchema: z.ZodType<TConfig>
  requiredPermissions: Permission[]
  /** Safe to run twice. A non-idempotent action is never replayed. */
  idempotent: boolean
  /** Where its effect lands, shown in the builder so the risk is visible. */
  sideEffect: 'none' | 'internal' | 'external'
  execute(context: ActionContext, config: TConfig): Promise<Record<string, unknown> | void>
}

const TRIGGERS = new Map<string, TriggerDefinition>()
const ACTIONS = new Map<string, ActionDefinition<never>>()

export function registerTrigger(definition: TriggerDefinition): void {
  if (TRIGGERS.has(definition.type)) {
    throw new Error(`Duplicate workflow trigger: ${definition.type}`)
  }
  TRIGGERS.set(definition.type, definition)
}

export function registerAction<TConfig>(definition: ActionDefinition<TConfig>): void {
  if (ACTIONS.has(definition.type)) {
    throw new Error(`Duplicate workflow action: ${definition.type}`)
  }
  ACTIONS.set(definition.type, definition as ActionDefinition<never>)
}

export const getTrigger = (type: string): TriggerDefinition | undefined => TRIGGERS.get(type)
export const getAction = (type: string): ActionDefinition<never> | undefined => ACTIONS.get(type)

export const listTriggers = (): TriggerDefinition[] =>
  [...TRIGGERS.values()].sort((a, b) => a.label.localeCompare(b.label))

export const listActions = (): Array<ActionDefinition<never>> =>
  [...ACTIONS.values()].sort((a, b) => a.label.localeCompare(b.label))

/** Which triggers listen for a given outbox event. */
export function triggersForEvent(eventType: string): TriggerDefinition[] {
  return [...TRIGGERS.values()].filter((trigger) =>
    trigger.eventTypes.includes(eventType as EventType),
  )
}

/** Test seam. */
export function resetRegistries(): void {
  TRIGGERS.clear()
  ACTIONS.clear()
}
