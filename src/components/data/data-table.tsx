'use client'

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, type ReactNode } from 'react'

import { EmptyState } from '@/components/feedback/states'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The one table in the product.
 *
 * Sorting and pagination are SERVER-side and live in the URL, not in component
 * state (docs/OPERATIONS.md §M.3). Three consequences that matter: a filtered
 * view is a shareable link, the back button works, and the database never has to
 * return ten thousand rows for the client to slice.
 *
 * Deliberately no headless table library: with sorting, filtering and pagination
 * all happening in SQL, a library would contribute a row model we never use and
 * an API surface to keep up with. The column contract below is the whole thing.
 */

export interface Column<TRow> {
  /** Matches the `sort` query parameter when the column is sortable. */
  id: string
  header: ReactNode
  cell: (row: TRow) => ReactNode
  /** Sortable only if the server supports ordering by this column. */
  sortable?: boolean
  /** Right-align and tabular-figure numeric columns so digits line up. */
  numeric?: boolean
  className?: string
  headerClassName?: string
}

export interface DataTablePagination {
  page: number
  pageSize: number
  total: number
}

export interface SortState {
  field: string
  direction: 'asc' | 'desc'
}

export function DataTable<TRow>({
  columns,
  rows,
  rowKey,
  pagination,
  sort,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  rowHref,
  className,
}: {
  columns: Column<TRow>[]
  rows: TRow[]
  rowKey: (row: TRow) => string
  pagination?: DataTablePagination
  sort?: SortState | undefined
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  rowHref?: (row: TRow) => string
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  /** Write query parameters, preserving the rest of the URL. */
  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) params.delete(key)
        else params.set(key, value)
      }
      router.push(`${pathname}?${params.toString()}`)
    },
    [pathname, router, searchParams],
  )

  const toggleSort = useCallback(
    (columnId: string) => {
      const nextDirection = sort?.field === columnId && sort.direction === 'asc' ? 'desc' : 'asc'
      // Back to page 1: page 4 of the old ordering is meaningless in the new one.
      setParams({ sort: columnId, dir: nextDirection, page: '1' })
    },
    [setParams, sort],
  )

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
  }

  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1

  return (
    <div className={cn('space-y-3', className)}>
      {/* Wide tables scroll inside their own container; the page never scrolls sideways. */}
      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted/50">
            <tr className="border-b">
              {columns.map((column) => {
                const active = sort?.field === column.id
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      active
                        ? sort.direction === 'desc'
                          ? 'descending'
                          : 'ascending'
                        : column.sortable
                          ? 'none'
                          : undefined
                    }
                    className={cn(
                      'text-muted-foreground px-3 py-2.5 text-left font-medium whitespace-nowrap',
                      column.numeric && 'text-right',
                      column.headerClassName,
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.id)}
                        className={cn(
                          'hover:text-foreground inline-flex items-center gap-1 transition-colors',
                          column.numeric && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        {active ? (
                          sort.direction === 'desc' ? (
                            <ArrowDown className="size-3" aria-hidden="true" />
                          ) : (
                            <ArrowUp className="size-3" aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const href = rowHref?.(row)
              return (
                <tr
                  key={rowKey(row)}
                  className="hover:bg-muted/40 border-b transition-colors last:border-0"
                >
                  {columns.map((column, index) => (
                    <td
                      key={column.id}
                      className={cn(
                        'px-3 py-2.5 align-middle',
                        column.numeric && 'tabular text-right',
                        column.className,
                      )}
                    >
                      {/* Only the first cell links, so the row is navigable
                          without nesting interactive elements in every cell. */}
                      {href && index === 0 ? (
                        <Link href={href} className="font-medium hover:underline">
                          {column.cell(row)}
                        </Link>
                      ) : (
                        column.cell(row)
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pagination && pagination.total > pagination.pageSize ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-xs">
            <span className="tabular">
              {(pagination.page - 1) * pagination.pageSize + 1}–
              {Math.min(pagination.page * pagination.pageSize, pagination.total)}
            </span>{' '}
            of <span className="tabular">{pagination.total}</span>
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setParams({ page: String(pagination.page - 1) })}
            >
              Previous
            </Button>
            <span className="text-muted-foreground tabular text-xs">
              {pagination.page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= totalPages}
              onClick={() => setParams({ page: String(pagination.page + 1) })}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
