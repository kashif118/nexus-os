import { describe, expect, it } from 'vitest'

import { safeRedirectPath } from '../guards'

describe('safeRedirectPath', () => {
  it('allows an absolute in-app path', () => {
    expect(safeRedirectPath('/account')).toBe('/account')
    expect(safeRedirectPath('/projects/123?tab=tasks')).toBe('/projects/123?tab=tasks')
  })

  it('falls back when nothing is supplied', () => {
    expect(safeRedirectPath(undefined)).toBe('/account')
    expect(safeRedirectPath(null)).toBe('/account')
    expect(safeRedirectPath('')).toBe('/account')
  })

  it('rejects absolute URLs to another origin', () => {
    expect(safeRedirectPath('https://evil.test/steal')).toBe('/account')
    expect(safeRedirectPath('http://evil.test')).toBe('/account')
  })

  it('rejects protocol-relative URLs', () => {
    expect(safeRedirectPath('//evil.test/steal')).toBe('/account')
  })

  it('rejects backslash variants that some browsers normalise', () => {
    expect(safeRedirectPath(String.raw`/\evil.test`)).toBe('/account')
    expect(safeRedirectPath(String.raw`\\evil.test`)).toBe('/account')
    expect(safeRedirectPath(String.raw`/path\with\backslash`)).toBe('/account')
  })

  it('rejects a scheme-only payload', () => {
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/account')
  })

  it('honours an explicit fallback', () => {
    expect(safeRedirectPath('https://evil.test', '/sign-in')).toBe('/sign-in')
  })
})
