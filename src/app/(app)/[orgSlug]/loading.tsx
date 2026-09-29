import { CardSkeleton, TableSkeleton } from '@/components/feedback/states'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The loading shell for every page under an organization.
 *
 * Without this file Next renders nothing at all until the server has finished
 * the page — and the pages here are wide reads: the Command Center resolves
 * every widget a role may see, analytics computes every metric. The navigation
 * appeared to hang for as long as that took, with no indication that anything
 * was happening.
 *
 * With it, the shell — sidebar, header, this skeleton — paints immediately and
 * the content streams in. The work on the server is identical; what changes is
 * that the browser has something to show while it happens.
 *
 * It is deliberately generic, because it stands in for a list page, a detail
 * page and a dashboard alike. A skeleton that mimics one specific layout is
 * wrong on every other route, and wrong is worse than plain.
 */
export default function OrgSectionLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <CardSkeleton key={index} />
        ))}
      </div>

      <TableSkeleton rows={6} columns={4} />
    </div>
  )
}
