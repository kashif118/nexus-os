import type { Permission } from '@/kernel/authz/catalogue'

import { referencedFields } from './conditions'
import { graphSchema, outgoing, type WorkflowGraph, type WorkflowNode } from './graph'
import { getAction, getTrigger } from './registry'

/**
 * Graph validation — pure, so publishing can refuse with a precise message
 * instead of a run failing later in front of a user.
 *
 * Everything checked here is something that would otherwise become a runtime
 * failure at the worst moment: an unreachable action that silently never runs,
 * a cycle that loops forever, a condition on a field the trigger does not
 * publish, or an action the owner is not allowed to perform.
 */

export interface ValidationIssue {
  nodeId?: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
  /** Every permission the published graph would need. */
  requiredPermissions: Permission[]
}

export function validateGraph(
  input: unknown,
  options: { ownerPermissions?: ReadonlySet<string> } = {},
): ValidationResult {
  const parsed = graphSchema.safeParse(input)

  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        message: `${issue.path.join('.') || 'graph'}: ${issue.message}`,
      })),
      requiredPermissions: [],
    }
  }

  const graph = parsed.data
  const issues: ValidationIssue[] = []
  const required = new Set<Permission>()

  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push({ nodeId: node.id, message: 'Duplicate node id.' })
    ids.add(node.id)
  }

  const triggers = graph.nodes.filter((node) => node.type === 'trigger')
  if (triggers.length === 0) issues.push({ message: 'A workflow needs a trigger.' })
  if (triggers.length > 1) issues.push({ message: 'A workflow may only have one trigger.' })

  const trigger = triggers[0]
  const triggerDefinition = trigger?.type === 'trigger' ? getTrigger(trigger.trigger) : undefined

  if (trigger?.type === 'trigger' && !triggerDefinition) {
    issues.push({ nodeId: trigger.id, message: `Unknown trigger "${trigger.trigger}".` })
  }

  const allowedFields = new Set(triggerDefinition?.fields.map((field) => field.path) ?? [])

  for (const node of graph.nodes) {
    checkNode(node, {
      issues,
      required,
      allowedFields,
      hasTriggerDefinition: Boolean(triggerDefinition),
    })
  }

  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) issues.push({ message: `Edge from unknown node "${edge.from}".` })
    if (!ids.has(edge.to)) issues.push({ message: `Edge to unknown node "${edge.to}".` })
    if (edge.from === edge.to) {
      issues.push({ nodeId: edge.from, message: 'A node cannot connect to itself.' })
    }
  }

  // Nothing may point back at the trigger: a trigger with an inbound edge would
  // be re-entered on every pass.
  if (trigger && graph.edges.some((edge) => edge.to === trigger.id)) {
    issues.push({ nodeId: trigger.id, message: 'Nothing may lead back into the trigger.' })
  }

  const cycle = findCycle(graph)
  if (cycle) {
    issues.push({ message: `The graph loops: ${cycle.join(' → ')}. A workflow must be acyclic.` })
  }

  if (trigger && !cycle) {
    const reachable = reachableFrom(graph, trigger.id)
    for (const node of graph.nodes) {
      if (node.id !== trigger.id && !reachable.has(node.id)) {
        issues.push({ nodeId: node.id, message: 'This step can never run: nothing leads to it.' })
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.type !== 'approval') continue

    const branches = new Set(outgoing(graph, node.id).map((edge) => edge.branch ?? ''))
    if (!branches.has('approved')) {
      issues.push({ nodeId: node.id, message: 'An approval needs an "approved" path.' })
    }
  }

  if (options.ownerPermissions) {
    for (const permission of required) {
      if (!options.ownerPermissions.has(permission)) {
        issues.push({
          message: `The workflow owner does not hold "${permission}", which one of its actions needs.`,
        })
      }
    }
  }

  return { valid: issues.length === 0, issues, requiredPermissions: [...required] }
}

function checkNode(
  node: WorkflowNode,
  state: {
    issues: ValidationIssue[]
    required: Set<Permission>
    allowedFields: Set<string>
    hasTriggerDefinition: boolean
  },
): void {
  if (node.type === 'condition') {
    if (!state.hasTriggerDefinition) return

    for (const field of referencedFields(node.expression)) {
      // A field the trigger does not publish can never be read at run time, so
      // the condition would silently never match. Better to refuse at publish.
      if (!state.allowedFields.has(field)) {
        state.issues.push({
          nodeId: node.id,
          message: `"${field}" is not a field this trigger provides.`,
        })
      }
    }
    return
  }

  if (node.type === 'action') {
    const definition = getAction(node.action)
    if (!definition) {
      state.issues.push({ nodeId: node.id, message: `Unknown action "${node.action}".` })
      return
    }

    const config = definition.configSchema.safeParse(node.config)
    if (!config.success) {
      for (const issue of config.error.issues) {
        state.issues.push({
          nodeId: node.id,
          message: `${definition.label}: ${issue.path.join('.') || 'config'} ${issue.message}`,
        })
      }
    }

    for (const permission of definition.requiredPermissions) state.required.add(permission)
    return
  }

  if (node.type === 'approval') {
    if (!node.config.approverMembershipId && !node.config.approverPermission) {
      state.issues.push({
        nodeId: node.id,
        message: 'An approval needs either a named approver or a permission that identifies one.',
      })
    }
  }
}

/** Depth-first cycle detection, returning the offending path for the message. */
function findCycle(graph: WorkflowGraph): string[] | null {
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
  }

  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const colour = new Map<string, number>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    colour.set(id, GREY)
    stack.push(id)

    for (const next of adjacency.get(id) ?? []) {
      const state = colour.get(next) ?? WHITE
      if (state === GREY) {
        const start = stack.indexOf(next)
        return [...stack.slice(start), next]
      }
      if (state === WHITE) {
        const found = visit(next)
        if (found) return found
      }
    }

    stack.pop()
    colour.set(id, BLACK)
    return null
  }

  for (const node of graph.nodes) {
    if ((colour.get(node.id) ?? WHITE) === WHITE) {
      const found = visit(node.id)
      if (found) return found
    }
  }

  return null
}

export function reachableFrom(graph: WorkflowGraph, startId: string): Set<string> {
  const reachable = new Set<string>()
  const queue = [startId]

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const edge of graph.edges) {
      if (edge.from !== current || reachable.has(edge.to)) continue
      reachable.add(edge.to)
      queue.push(edge.to)
    }
  }

  return reachable
}
