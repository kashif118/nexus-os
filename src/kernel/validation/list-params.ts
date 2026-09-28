import { z } from 'zod'

/**
 * Shared list contract (docs/OPERATIONS.md §M.3).
 *
 * Every list screen reads its page, sort and filters from the URL, and every
 * list query takes the parsed result. Centralising it buys three things:
 *
 * - **Injection safety.** Sort fields are validated against an allowlist the
 *   caller supplies, so an arbitrary column name can never reach the ORM.
 * - **A bounded page size.** A client cannot ask for a million rows.
 * - **Consistency.** Pagination, sorting and search behave the same on every
 *   screen because there is one implementation.
 */

export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 25

/**
 * Pagination, parsed leniently.
 *
 * URL parameters are user-editable, so a nonsensical value falls back to the
 * default and an oversized page is clamped — a list screen must never 500
 * because someone typed in the address bar. The clamp is the security-relevant
 * half: it bounds how much a caller can ask the database for.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .catch(DEFAULT_PAGE_SIZE)
    .transform((value) => Math.min(value, MAX_PAGE_SIZE)),
})

export interface ListParams<TSortField extends string> {
  page: number
  pageSize: number
  skip: number
  take: number
  sort: { field: TSortField; direction: 'asc' | 'desc' }
  q: string | undefined
}

export interface PageResult<TItem> {
  items: TItem[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

/**
 * Parse raw search params into a safe list query.
 *
 * `sortableFields` is the allowlist; anything else falls back to the default, so
 * `?sort=passwordHash` sorts by the default rather than leaking column names
 * through error messages.
 */
export function parseListParams<TSortField extends string>(
  searchParams: Record<string, string | string[] | undefined>,
  options: {
    sortableFields: readonly TSortField[]
    defaultSort: TSortField
    defaultDirection?: 'asc' | 'desc'
    defaultPageSize?: number
  },
): ListParams<TSortField> {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value

  const { page, pageSize } = paginationSchema.parse({
    page: single(searchParams.page) ?? 1,
    pageSize: single(searchParams.pageSize) ?? options.defaultPageSize ?? DEFAULT_PAGE_SIZE,
  })

  const requestedSort = single(searchParams.sort)
  const field = options.sortableFields.includes(requestedSort as TSortField)
    ? (requestedSort as TSortField)
    : options.defaultSort

  const direction =
    single(searchParams.dir) === 'desc'
      ? 'desc'
      : single(searchParams.dir) === 'asc'
        ? 'asc'
        : (options.defaultDirection ?? 'desc')

  const rawQuery = single(searchParams.q)?.trim()
  // An empty or absurdly long search is treated as no search rather than an
  // error: a list screen should never fail because of a stray query string.
  const q = rawQuery && rawQuery.length > 0 && rawQuery.length <= 200 ? rawQuery : undefined

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
    sort: { field, direction },
    ...(q === undefined ? { q: undefined } : { q }),
  }
}

/** Assemble a page result from a count and a slice. */
export function toPageResult<TItem>(
  items: TItem[],
  total: number,
  params: { page: number; pageSize: number },
): PageResult<TItem> {
  return {
    items,
    total,
    page: params.page,
    pageSize: params.pageSize,
    hasMore: params.page * params.pageSize < total,
  }
}

/**
 * A case-insensitive "contains" filter for Postgres.
 *
 * Wrapped so search behaves identically across modules, and so switching to a
 * full-text index later is a change in one place.
 */
export const containsInsensitive = (value: string) => ({
  contains: value,
  mode: 'insensitive' as const,
})
