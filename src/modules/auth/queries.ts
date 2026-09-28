import { getAccountOverview as getAccountOverviewService } from './service'

/**
 * Read boundary for Server Components (docs/ARCHITECTURE.md §M.1).
 *
 * The UI layer is not permitted to import a service directly — the lint
 * boundary rules enforce it — so reads funnel through here. Today this is a thin
 * pass-through; it becomes the place for cache tagging and DTO narrowing as the
 * surface grows.
 */
export async function getAccountOverview(userId: string) {
  return getAccountOverviewService(userId)
}
