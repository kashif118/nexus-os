import { z } from 'zod'

/**
 * The workflow graph (docs/AI-AND-AUTOMATION.md §L.1).
 *
 * A graph is data, not code. It is stored as JSON, validated by this schema
 * plus the structural checks in `validate.ts`, and interpreted by the engine —
 * there is no code generation and nothing is ever evaluated as a string.
 *
 * `schemaVersion` is on the graph rather than implied by the row so that a
 * published version from a year ago still says what shape it is in.
 */

export const COMPARATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'in',
  'notIn',
  'between',
  'isEmpty',
  'isNotEmpty',
  'changed',
  'changedTo',
] as const

export type Comparator = (typeof COMPARATORS)[number]

/** A comparison, or a boolean tree of them. Deliberately finite. */
export type ConditionExpression =
  | { kind: 'compare'; field: string; comparator: Comparator; value?: unknown }
  | { kind: 'and'; operands: ConditionExpression[] }
  | { kind: 'or'; operands: ConditionExpression[] }
  | { kind: 'not'; operand: ConditionExpression }
  | { kind: 'always' }

export const conditionSchema: z.ZodType<ConditionExpression> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('compare'),
      field: z.string().min(1).max(120),
      comparator: z.enum(COMPARATORS),
      value: z.unknown().optional(),
    }),
    z.object({ kind: z.literal('and'), operands: z.array(conditionSchema).min(1).max(20) }),
    z.object({ kind: z.literal('or'), operands: z.array(conditionSchema).min(1).max(20) }),
    z.object({ kind: z.literal('not'), operand: conditionSchema }),
    z.object({ kind: z.literal('always') }),
  ]),
)

const nodeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Node ids may use letters, digits, hyphens and underscores.')

const configObject = z.record(z.string(), z.unknown()).default({})

export const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    id: nodeId,
    type: z.literal('trigger'),
    trigger: z.string().min(1).max(64),
    config: configObject,
  }),
  z.object({
    id: nodeId,
    type: z.literal('condition'),
    expression: conditionSchema,
  }),
  z.object({
    id: nodeId,
    type: z.literal('action'),
    action: z.string().min(1).max(64),
    config: configObject,
  }),
  z.object({
    id: nodeId,
    type: z.literal('delay'),
    config: z.object({
      seconds: z
        .number()
        .int()
        .min(1)
        .max(60 * 60 * 24 * 30),
    }),
  }),
  z.object({
    id: nodeId,
    type: z.literal('approval'),
    config: z.object({
      approverMembershipId: z.string().max(64).optional(),
      approverPermission: z.string().max(64).optional(),
      timeoutHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .default(48),
    }),
  }),
])

export type WorkflowNode = z.infer<typeof nodeSchema>

export const edgeSchema = z.object({
  from: nodeId,
  to: nodeId,
  /** Which outcome this edge follows: "approved", "rejected", "timeout". */
  branch: z.string().max(32).optional(),
})

export type WorkflowEdge = z.infer<typeof edgeSchema>

export const graphSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(nodeSchema).min(1).max(60),
  edges: z.array(edgeSchema).max(120).default([]),
})

export type WorkflowGraph = z.infer<typeof graphSchema>

/** The empty graph a new workflow starts from. */
export function emptyGraph(triggerType: string): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [{ id: 'trigger', type: 'trigger', trigger: triggerType, config: {} }],
    edges: [],
  }
}

export function findNode(graph: WorkflowGraph, id: string): WorkflowNode | undefined {
  return graph.nodes.find((node) => node.id === id)
}

export function triggerNode(
  graph: WorkflowGraph,
): Extract<WorkflowNode, { type: 'trigger' }> | undefined {
  return graph.nodes.find(
    (node): node is Extract<WorkflowNode, { type: 'trigger' }> => node.type === 'trigger',
  )
}

/** Edges leaving a node, optionally filtered to one branch. */
export function outgoing(graph: WorkflowGraph, nodeId: string, branch?: string): WorkflowEdge[] {
  return graph.edges.filter(
    (edge) =>
      edge.from === nodeId && (branch === undefined || (edge.branch ?? undefined) === branch),
  )
}
