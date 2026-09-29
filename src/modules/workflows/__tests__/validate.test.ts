import { describe, expect, it } from 'vitest'

import '../builtin-actions'
import '../triggers'

import { renderTemplate } from '../builtin-actions'
import { emptyGraph } from '../graph'
import { validateGraph } from '../validate'

const base = () => ({
  schemaVersion: 1 as const,
  nodes: [
    { id: 'trigger', type: 'trigger' as const, trigger: 'invoice.overdue', config: {} },
    {
      id: 'big',
      type: 'condition' as const,
      expression: {
        kind: 'compare' as const,
        field: 'totalMinor',
        comparator: 'gt' as const,
        value: 100_000,
      },
    },
    {
      id: 'log',
      type: 'action' as const,
      action: 'activity.log',
      config: { summary: 'Chased {{number}}' },
    },
  ],
  edges: [
    { from: 'trigger', to: 'big' },
    { from: 'big', to: 'log' },
  ] as Array<{ from: string; to: string; branch?: string }>,
})

const messages = (graph: unknown) => validateGraph(graph).issues.map((issue) => issue.message)

describe('validateGraph', () => {
  it('accepts a well-formed graph', () => {
    const result = validateGraph(base())
    expect(result.valid, result.issues.map((issue) => issue.message).join('; ')).toBe(true)
  })

  it('rejects a graph with no trigger', () => {
    const graph = base()
    graph.nodes = graph.nodes.filter((node) => node.type !== 'trigger') as never
    expect(messages(graph)).toContain('A workflow needs a trigger.')
  })

  it('rejects two triggers', () => {
    const graph = base()
    graph.nodes.push({
      id: 'trigger2',
      type: 'trigger',
      trigger: 'invoice.paid',
      config: {},
    } as never)

    expect(messages(graph)).toContain('A workflow may only have one trigger.')
  })

  it('rejects an unknown trigger', () => {
    const graph = emptyGraph('nope.not.real')
    expect(messages(graph).join(' ')).toContain('Unknown trigger')
  })

  it('rejects an unknown action', () => {
    const graph = base()
    graph.nodes[2] = { id: 'log', type: 'action', action: 'drop.database', config: {} } as never
    expect(messages(graph).join(' ')).toContain('Unknown action')
  })

  it('rejects a condition on a field the trigger does not publish', () => {
    // Without this check the condition would silently never match, and the
    // author would have no way to tell whether the rule or the data was wrong.
    const graph = base()
    graph.nodes[1] = {
      id: 'big',
      type: 'condition',
      expression: { kind: 'compare', field: 'secretSalary', comparator: 'gt', value: 1 },
    } as never

    expect(messages(graph).join(' ')).toContain('not a field this trigger provides')
  })

  it('rejects an action whose config does not type-check', () => {
    const graph = base()
    graph.nodes[2] = {
      id: 'log',
      type: 'action',
      action: 'notification.send',
      config: { title: 'Hello' }, // missing recipientMembershipId
    } as never

    expect(messages(graph).join(' ')).toContain('recipientMembershipId')
  })

  it('rejects a cycle', () => {
    const graph = base()
    graph.edges.push({ from: 'log', to: 'big' })
    expect(messages(graph).join(' ')).toContain('loops')
  })

  it('rejects an edge back into the trigger', () => {
    const graph = base()
    graph.edges.push({ from: 'log', to: 'trigger' })
    expect(messages(graph).join(' ')).toContain('lead back into the trigger')
  })

  it('rejects an unreachable step', () => {
    const graph = base()
    graph.nodes.push({
      id: 'orphan',
      type: 'action',
      action: 'activity.log',
      config: { summary: 'never' },
    } as never)

    expect(messages(graph).join(' ')).toContain('can never run')
  })

  it('rejects an edge to a node that does not exist', () => {
    const graph = base()
    graph.edges.push({ from: 'log', to: 'ghost' })
    expect(messages(graph).join(' ')).toContain('Edge to unknown node')
  })

  it('rejects a self-referencing edge', () => {
    const graph = base()
    graph.edges.push({ from: 'log', to: 'log' })
    expect(messages(graph).join(' ')).toContain('cannot connect to itself')
  })

  it('requires an approval to have an approved path', () => {
    const graph = base()
    graph.nodes.push({
      id: 'sign-off',
      type: 'approval',
      config: { approverPermission: 'finance.invoice.send', timeoutHours: 48 },
    } as never)
    graph.edges.push({ from: 'log', to: 'sign-off' })

    expect(messages(graph).join(' ')).toContain('"approved" path')
  })

  it('requires an approval to name an approver somehow', () => {
    const graph = base()
    graph.nodes.push({
      id: 'sign-off',
      type: 'approval',
      config: { timeoutHours: 48 },
    } as never)
    graph.edges.push({ from: 'log', to: 'sign-off' })
    graph.edges.push({ from: 'sign-off', to: 'log', branch: 'approved' })

    expect(messages(graph).join(' ')).toContain('named approver')
  })

  it('collects the permissions the graph needs', () => {
    const graph = base()
    graph.nodes.push({
      id: 'follow-up',
      type: 'action',
      action: 'task.create',
      config: { title: 'Chase {{number}}' },
    } as never)
    graph.edges.push({ from: 'log', to: 'follow-up' })

    expect(validateGraph(graph).requiredPermissions).toContain('task.create')
  })

  it('refuses to publish when the owner lacks a permission an action needs', () => {
    const graph = base()
    graph.nodes.push({
      id: 'follow-up',
      type: 'action',
      action: 'task.create',
      config: { title: 'Chase' },
    } as never)
    graph.edges.push({ from: 'log', to: 'follow-up' })

    const result = validateGraph(graph, { ownerPermissions: new Set() })
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.message).join(' ')).toContain('does not hold')
  })

  it('passes when the owner does hold it', () => {
    const graph = base()
    graph.nodes.push({
      id: 'follow-up',
      type: 'action',
      action: 'task.create',
      config: { title: 'Chase' },
    } as never)
    graph.edges.push({ from: 'log', to: 'follow-up' })

    const result = validateGraph(graph, { ownerPermissions: new Set(['task.create']) })
    expect(result.valid, result.issues.map((issue) => issue.message).join('; ')).toBe(true)
  })

  it('rejects a graph that is not a graph at all', () => {
    expect(validateGraph({ nodes: 'lots' }).valid).toBe(false)
    expect(validateGraph(null).valid).toBe(false)
    expect(validateGraph('{}').valid).toBe(false)
  })
})

describe('renderTemplate', () => {
  it('substitutes flat keys', () => {
    expect(
      renderTemplate('Chase {{number}} for {{companyName}}', {
        number: 'INV-0001',
        companyName: 'Acme',
      }),
    ).toBe('Chase INV-0001 for Acme')
  })

  it('renders an unknown key as empty rather than throwing', () => {
    expect(renderTemplate('Hello {{nope}}!', {})).toBe('Hello !')
  })

  it('does not interpret anything beyond the placeholder', () => {
    // No expression evaluation: the whole point of one regex over flat keys.
    expect(renderTemplate('{{ a }} {{b.c}} {{1+1}}', { a: 'x' })).toBe('x  {{1+1}}')
  })

  it('formats a date as a plain day', () => {
    expect(renderTemplate('{{when}}', { when: new Date('2026-03-04T10:00:00Z') })).toBe(
      '2026-03-04',
    )
  })
})
