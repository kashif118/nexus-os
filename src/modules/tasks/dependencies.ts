/**
 * Task dependency logic.
 *
 * Two things must hold and neither can be left to the UI:
 *
 * 1. **No cycles.** A depends on B depends on C depends on A makes the graph
 *    unsatisfiable and any "what can I start?" query non-terminating.
 * 2. **Blocked work cannot be started.** If B depends on A finishing, moving B
 *    to In Progress while A is open is a lie the board would happily tell.
 *
 * Kept pure — the graph is passed in as edges — so both rules are exhaustively
 * testable without a database, and so the same code can check a proposed edge
 * before it is written.
 */

export interface DependencyEdge {
  /** The task that is blocked. */
  taskId: string
  /** The task that must be satisfied first. */
  dependsOnTaskId: string
  type?: 'FINISH_START' | 'START_START' | 'FINISH_FINISH'
}

/** Statuses that mean a task is finished for dependency purposes. */
const TERMINAL = new Set(['DONE', 'CANCELLED'])

/** Statuses that mean work has begun. */
const STARTED = new Set(['IN_PROGRESS', 'REVIEW', 'DONE'])

/**
 * Build an adjacency map from a task to everything it depends on.
 */
export function buildGraph(edges: readonly DependencyEdge[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    graph.set(edge.taskId, [...(graph.get(edge.taskId) ?? []), edge.dependsOnTaskId])
  }
  return graph
}

/**
 * Would adding `taskId → dependsOnTaskId` create a cycle?
 *
 * Walks the existing graph from the proposed prerequisite: if the blocked task
 * is reachable, the new edge would close a loop. Iterative rather than
 * recursive so a deep chain cannot blow the stack.
 */
export function wouldCreateCycle(
  edges: readonly DependencyEdge[],
  candidate: { taskId: string; dependsOnTaskId: string },
): boolean {
  // The degenerate case the UI is most likely to send.
  if (candidate.taskId === candidate.dependsOnTaskId) return true

  const graph = buildGraph(edges)
  const stack = [candidate.dependsOnTaskId]
  const seen = new Set<string>()

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === candidate.taskId) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(graph.get(current) ?? []))
  }

  return false
}

/** Every task reachable as a prerequisite, directly or transitively. */
export function transitivePrerequisites(
  edges: readonly DependencyEdge[],
  taskId: string,
): Set<string> {
  const graph = buildGraph(edges)
  const result = new Set<string>()
  const stack = [...(graph.get(taskId) ?? [])]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (result.has(current)) continue
    result.add(current)
    stack.push(...(graph.get(current) ?? []))
  }

  return result
}

export interface BlockingTask {
  id: string
  title: string
  status: string
  type: 'FINISH_START' | 'START_START' | 'FINISH_FINISH'
}

/**
 * Which prerequisites currently block a move to `targetStatus`?
 *
 * Returns the blockers rather than a boolean so the UI can name them — "blocked
 * by NEX-12 Design review" is actionable, "blocked" is not.
 */
export function blockersFor(
  targetStatus: string,
  prerequisites: readonly BlockingTask[],
): BlockingTask[] {
  // Moving backwards, or to a terminal state, is never blocked: unblocking work
  // by cancelling it is legitimate.
  if (targetStatus === 'BACKLOG' || targetStatus === 'TODO' || TERMINAL.has(targetStatus)) {
    return []
  }

  return prerequisites.filter((prerequisite) => {
    switch (prerequisite.type) {
      case 'START_START':
        // The prerequisite must have started.
        return !STARTED.has(prerequisite.status)
      case 'FINISH_FINISH':
        // Only constrains finishing, which the guard above already allows.
        return false
      case 'FINISH_START':
      default:
        return !TERMINAL.has(prerequisite.status)
    }
  })
}

export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status)

/* -------------------------------------------------------------------------- */
/* Board ordering                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rank for a card dropped between two neighbours.
 *
 * Fractional ranking means a drag updates ONE row instead of renumbering the
 * column, which matters when a board holds hundreds of cards and several people
 * are dragging at once.
 *
 * Doubles run out of precision after roughly fifty consecutive midpoint splits
 * in the same gap; `needsRebalance` detects that so the caller can renumber the
 * column, which is rare enough to be cheap.
 */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1000
  if (before === null) return after! - 1000
  if (after === null) return before + 1000
  return (before + after) / 2
}

/** True when neighbours have converged so closely that ranks must be rebuilt. */
export function needsRebalance(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return false
  return Math.abs(after - before) < 0.0001
}

/** Evenly spaced ranks for a rebuilt column. */
export function rebalancedRanks(count: number, step = 1000): number[] {
  return Array.from({ length: count }, (_, index) => (index + 1) * step)
}
