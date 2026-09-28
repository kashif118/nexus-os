import { describe, expect, it } from 'vitest'

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseListParams, toPageResult } from '../list-params'

const options = {
  sortableFields: ['createdAt', 'name', 'status'] as const,
  defaultSort: 'createdAt' as const,
}

describe('parseListParams', () => {
  it('applies defaults for an empty query string', () => {
    const params = parseListParams({}, options)
    expect(params.page).toBe(1)
    expect(params.pageSize).toBe(DEFAULT_PAGE_SIZE)
    expect(params.sort).toEqual({ field: 'createdAt', direction: 'desc' })
    expect(params.q).toBeUndefined()
  })

  it('computes skip and take from the page', () => {
    const params = parseListParams({ page: '3', pageSize: '10' }, options)
    expect(params.skip).toBe(20)
    expect(params.take).toBe(10)
  })

  it('accepts an allowlisted sort field', () => {
    expect(parseListParams({ sort: 'name', dir: 'asc' }, options).sort).toEqual({
      field: 'name',
      direction: 'asc',
    })
  })

  it('falls back to the default for a field that is not allowlisted', () => {
    // The security property: an arbitrary column name never reaches the ORM.
    expect(parseListParams({ sort: 'passwordHash' }, options).sort.field).toBe('createdAt')
    expect(parseListParams({ sort: 'id; DROP TABLE users' }, options).sort.field).toBe('createdAt')
  })

  it('caps the page size', () => {
    expect(parseListParams({ pageSize: '100000' }, options).pageSize).toBe(MAX_PAGE_SIZE)
  })

  it('falls back to page 1 for a non-numeric page rather than crashing', () => {
    // URL parameters are user-editable; a list screen must not 500 because
    // someone typed in the address bar.
    expect(parseListParams({ page: 'abc' }, options).page).toBe(1)
  })

  it('clamps a negative page', () => {
    expect(parseListParams({ page: '-5' }, options).page).toBe(1)
  })

  it('ignores an empty search term', () => {
    expect(parseListParams({ q: '   ' }, options).q).toBeUndefined()
  })

  it('trims a search term', () => {
    expect(parseListParams({ q: '  acme  ' }, options).q).toBe('acme')
  })

  it('ignores an absurdly long search term', () => {
    expect(parseListParams({ q: 'x'.repeat(500) }, options).q).toBeUndefined()
  })

  it('takes the first value when a parameter repeats', () => {
    expect(parseListParams({ sort: ['name', 'status'] }, options).sort.field).toBe('name')
  })

  it('defaults an unrecognised direction', () => {
    expect(parseListParams({ dir: 'sideways' }, options).sort.direction).toBe('desc')
  })
})

describe('toPageResult', () => {
  it('reports more pages remaining', () => {
    const result = toPageResult([1, 2, 3], 30, { page: 1, pageSize: 10 })
    expect(result.hasMore).toBe(true)
    expect(result.total).toBe(30)
  })

  it('reports the last page', () => {
    expect(toPageResult([1], 21, { page: 3, pageSize: 10 }).hasMore).toBe(false)
  })

  it('handles an empty result', () => {
    const result = toPageResult([], 0, { page: 1, pageSize: 25 })
    expect(result.items).toEqual([])
    expect(result.hasMore).toBe(false)
  })
})
