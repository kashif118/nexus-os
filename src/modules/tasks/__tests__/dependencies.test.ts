import { describe, expect, it } from 'vitest'

import {
  blockersFor,
  buildGraph,
  needsRebalance,
  rankBetween,
  rebalancedRanks,
  transitivePrerequisites,
  wouldCreateCycle,
  type BlockingTask,
  type DependencyEdge,
} from '../dependencies'

const edge = (taskId: string, dependsOnTaskId: string): DependencyEdge => ({
  taskId,
  dependsOnTaskId,
})

describe('buildGraph', () => {
  it('maps a task to everything it depends on', () => {
    const graph = buildGraph([edge('b', 'a'), edge('b', 'c')])
    expect(graph.get('b')).toEqual(['a', 'c'])
  })

  it('handles an empty graph', () => {
    expect(buildGraph([]).size).toBe(0)
  })
})

describe('wouldCreateCycle', () => {
  it('rejects a self-dependency', () => {
    expect(wouldCreateCycle([], { taskId: 'a', dependsOnTaskId: 'a' })).toBe(true)
  })

  it('allows an unrelated edge', () => {
    expect(wouldCreateCycle([edge('b', 'a')], { taskId: 'd', dependsOnTaskId: 'c' })).toBe(false)
  })

  it('rejects a direct two-task cycle', () => {
    // b already depends on a; making a depend on b closes the loop.
    expect(wouldCreateCycle([edge('b', 'a')], { taskId: 'a', dependsOnTaskId: 'b' })).toBe(true)
  })

  it('rejects a transitive cycle', () => {
    const edges = [edge('b', 'a'), edge('c', 'b')]
    expect(wouldCreateCycle(edges, { taskId: 'a', dependsOnTaskId: 'c' })).toBe(true)
  })

  it('rejects a long transitive cycle', () => {
    const edges = Array.from({ length: 50 }, (_, index) => edge(`t${index + 1}`, `t${index}`))
    expect(wouldCreateCycle(edges, { taskId: 't0', dependsOnTaskId: 't50' })).toBe(true)
  })

  it('allows a diamond, which is not a cycle', () => {
    // b and c both depend on a; d depends on both. Perfectly legal.
    const edges = [edge('b', 'a'), edge('c', 'a'), edge('d', 'b')]
    expect(wouldCreateCycle(edges, { taskId: 'd', dependsOnTaskId: 'c' })).toBe(false)
  })

  it('terminates on a graph that already contains a cycle', () => {
    // Defensive: bad data must not hang the request.
    const edges = [edge('a', 'b'), edge('b', 'a')]
    expect(wouldCreateCycle(edges, { taskId: 'c', dependsOnTaskId: 'a' })).toBe(false)
  })

  it('handles a deep chain without stack overflow', () => {
    const edges = Array.from({ length: 10_000 }, (_, index) => edge(`t${index + 1}`, `t${index}`))
    expect(wouldCreateCycle(edges, { taskId: 'x', dependsOnTaskId: 't10000' })).toBe(false)
  })
})

describe('transitivePrerequisites', () => {
  it('collects the whole chain', () => {
    const edges = [edge('c', 'b'), edge('b', 'a')]
    expect([...transitivePrerequisites(edges, 'c')].sort()).toEqual(['a', 'b'])
  })

  it('returns nothing for an independent task', () => {
    expect(transitivePrerequisites([edge('b', 'a')], 'z').size).toBe(0)
  })

  it('does not loop forever on cyclic data', () => {
    const edges = [edge('a', 'b'), edge('b', 'a')]
    expect(transitivePrerequisites(edges, 'a').size).toBe(2)
  })
})

describe('blockersFor', () => {
  const open: BlockingTask = { id: 'a', title: 'Design', status: 'TODO', type: 'FINISH_START' }
  const done: BlockingTask = { id: 'a', title: 'Design', status: 'DONE', type: 'FINISH_START' }

  it('blocks starting work when a prerequisite is unfinished', () => {
    expect(blockersFor('IN_PROGRESS', [open])).toHaveLength(1)
  })

  it('allows starting when the prerequisite is done', () => {
    expect(blockersFor('IN_PROGRESS', [done])).toHaveLength(0)
  })

  it('treats a cancelled prerequisite as satisfied', () => {
    const cancelled: BlockingTask = { ...open, status: 'CANCELLED' }
    expect(blockersFor('IN_PROGRESS', [cancelled])).toHaveLength(0)
  })

  it('never blocks a move back to the backlog', () => {
    expect(blockersFor('BACKLOG', [open])).toHaveLength(0)
    expect(blockersFor('TODO', [open])).toHaveLength(0)
  })

  it('never blocks cancelling, since that is how work gets unblocked', () => {
    expect(blockersFor('CANCELLED', [open])).toHaveLength(0)
  })

  it('names the blockers so the message can be specific', () => {
    const blockers = blockersFor('REVIEW', [open])
    expect(blockers[0]?.title).toBe('Design')
  })

  it('honours START_START, which only needs the prerequisite begun', () => {
    const startStart: BlockingTask = { ...open, type: 'START_START', status: 'IN_PROGRESS' }
    expect(blockersFor('IN_PROGRESS', [startStart])).toHaveLength(0)

    const notStarted: BlockingTask = { ...startStart, status: 'TODO' }
    expect(blockersFor('IN_PROGRESS', [notStarted])).toHaveLength(1)
  })

  it('does not let FINISH_FINISH block starting', () => {
    const finishFinish: BlockingTask = { ...open, type: 'FINISH_FINISH' }
    expect(blockersFor('IN_PROGRESS', [finishFinish])).toHaveLength(0)
  })

  it('reports every unsatisfied prerequisite, not just the first', () => {
    const second: BlockingTask = { id: 'b', title: 'Spec', status: 'TODO', type: 'FINISH_START' }
    expect(blockersFor('IN_PROGRESS', [open, second])).toHaveLength(2)
  })
})

describe('board ranking', () => {
  it('ranks the first card in an empty column', () => {
    expect(rankBetween(null, null)).toBe(1000)
  })

  it('ranks above the top card', () => {
    expect(rankBetween(null, 1000)).toBeLessThan(1000)
  })

  it('ranks below the bottom card', () => {
    expect(rankBetween(1000, null)).toBeGreaterThan(1000)
  })

  it('takes the midpoint between neighbours', () => {
    expect(rankBetween(1000, 2000)).toBe(1500)
  })

  it('keeps ordering after repeated splits', () => {
    let before = 1000
    const after = 2000
    for (let index = 0; index < 20; index += 1) {
      const rank = rankBetween(before, after)
      expect(rank).toBeGreaterThan(before)
      expect(rank).toBeLessThan(after)
      before = rank
    }
  })

  it('detects when precision has run out', () => {
    expect(needsRebalance(1000, 2000)).toBe(false)
    expect(needsRebalance(1000, 1000.00001)).toBe(true)
  })

  it('does not ask to rebalance at the ends of a column', () => {
    expect(needsRebalance(null, 1000)).toBe(false)
    expect(needsRebalance(1000, null)).toBe(false)
  })

  it('produces evenly spaced ranks when rebuilding', () => {
    expect(rebalancedRanks(3)).toEqual([1000, 2000, 3000])
  })
})
