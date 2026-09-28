import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetRegistry,
  allWidgets,
  registerWidget,
  resolveWidgets,
  visibleWidgets,
  type WidgetDefinition,
} from '../registry'
import type { Ctx } from '@/kernel/tenancy/ctx'

/** A Ctx stub carrying only what the registry touches. */
function ctxWith(permissions: string[]): Ctx {
  const held = new Set(permissions)
  return {
    orgSlug: 'acme',
    canAny: (candidates: readonly string[]) => candidates.some((key) => held.has(key)),
    can: (key: string) => held.has(key),
  } as unknown as Ctx
}

const stat = (id: string, overrides: Partial<WidgetDefinition> = {}): WidgetDefinition => ({
  id,
  title: id,
  description: '',
  kind: 'stat',
  span: 3,
  module: 'test',
  resolve: async () => ({ kind: 'stat', value: '1' }),
  ...overrides,
})

beforeEach(() => __resetRegistry())

describe('registration', () => {
  it('registers a widget', () => {
    registerWidget(stat('a'))
    expect(allWidgets()).toHaveLength(1)
  })

  it('refuses a duplicate id rather than overwriting silently', () => {
    registerWidget(stat('a'))
    expect(() => registerWidget(stat('a'))).toThrow(/Duplicate/)
  })
})

describe('permission filtering', () => {
  it('shows widgets with no requirement to everyone', () => {
    registerWidget(stat('open'))
    expect(visibleWidgets(ctxWith([]))).toHaveLength(1)
  })

  it('hides a widget the actor cannot see', () => {
    registerWidget(stat('money', { requires: ['finance.report.view'] }))
    expect(visibleWidgets(ctxWith([]))).toHaveLength(0)
  })

  it('shows a widget when any required permission is held', () => {
    registerWidget(stat('money', { requires: ['finance.report.view', 'analytics.view.org'] }))
    expect(visibleWidgets(ctxWith(['analytics.view.org']))).toHaveLength(1)
  })

  it('never runs the resolver of a hidden widget', async () => {
    const resolve = vi.fn(async () => ({ kind: 'stat' as const, value: 'secret' }))
    registerWidget(stat('money', { requires: ['finance.report.view'], resolve }))

    const ctx = ctxWith([])
    await resolveWidgets(ctx, visibleWidgets(ctx))

    // The security property: an unauthorised actor does not even trigger the
    // query behind a widget they cannot see.
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('fault isolation', () => {
  it('degrades one failing widget instead of the dashboard', async () => {
    registerWidget(stat('good'))
    registerWidget(
      stat('bad', {
        resolve: async () => {
          throw new Error('database exploded')
        },
      }),
    )

    const ctx = ctxWith([])
    const resolved = await resolveWidgets(ctx, visibleWidgets(ctx))

    expect(resolved).toHaveLength(2)
    expect(resolved.find((entry) => entry.definition.id === 'good')?.value).toEqual({
      kind: 'stat',
      value: '1',
    })

    const failed = resolved.find((entry) => entry.definition.id === 'bad')
    expect(failed?.value).toBeNull()
    expect(failed?.error).toBeTruthy()
  })

  it('does not leak the underlying error message to the client', async () => {
    registerWidget(
      stat('bad', {
        resolve: async () => {
          throw new Error('connection string postgres://user:secret@host')
        },
      }),
    )

    const ctx = ctxWith([])
    const [resolved] = await resolveWidgets(ctx, visibleWidgets(ctx))
    expect(resolved?.error).not.toContain('postgres://')
  })
})
