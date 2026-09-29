import { describe, expect, it } from 'vitest'

import { EVENT_CATALOGUE, EVENT_TYPES } from '@/kernel/events'

import { channelLabels, planDelivery, resolveChannels, type Recipient } from '../delivery'
import { renderEmail, renderNotification } from '../render'

const recipient = (id: string, overrides: Partial<Recipient> = {}): Recipient => ({
  membershipId: id,
  email: `${id}@example.test`,
  name: id,
  preferences: [],
  ...overrides,
})

describe('resolveChannels', () => {
  it('uses the catalogue default when nothing is stored', () => {
    expect(resolveChannels('task.assigned', [])).toEqual({
      inApp: EVENT_CATALOGUE['task.assigned'].defaultInApp,
      email: EVENT_CATALOGUE['task.assigned'].defaultEmail,
      digest: false,
    })
  })

  it('a stored row wins over the default, including turning things off', () => {
    const stored = [{ eventType: 'task.mentioned', inApp: false, email: false, digest: true }]
    expect(resolveChannels('task.mentioned', stored)).toEqual({
      inApp: false,
      email: false,
      digest: true,
    })
  })

  it('a row for a different event does not affect this one', () => {
    const stored = [{ eventType: 'invoice.paid', inApp: false, email: false, digest: false }]
    expect(resolveChannels('task.assigned', stored).inApp).toBe(true)
  })
})

describe('planDelivery', () => {
  it('never notifies the actor about their own action', () => {
    const planned = planDelivery('task.assigned', [recipient('m1'), recipient('m2')], 'm1')
    expect(planned.map((entry) => entry.membershipId)).toEqual(['m2'])
  })

  it('collapses a duplicate recipient into one notification', () => {
    const planned = planDelivery('task.assigned', [recipient('m1'), recipient('m1')], null)
    expect(planned).toHaveLength(1)
  })

  it('drops anyone who has turned every channel off', () => {
    const silenced = recipient('m2', {
      preferences: [{ eventType: 'task.assigned', inApp: false, email: false, digest: false }],
    })

    expect(planDelivery('task.assigned', [silenced], null)).toEqual([])
  })

  it('keeps someone who has only email on', () => {
    const emailOnly = recipient('m2', {
      preferences: [{ eventType: 'task.assigned', inApp: false, email: true, digest: false }],
    })

    const planned = planDelivery('task.assigned', [emailOnly], null)
    expect(planned).toHaveLength(1)
    expect(planned[0]?.channels).toEqual({ inApp: false, email: true, digest: false })
  })

  it('returns nothing for an empty audience', () => {
    expect(planDelivery('task.assigned', [], null)).toEqual([])
  })
})

describe('channelLabels', () => {
  it('records only the channels actually used', () => {
    expect(channelLabels({ inApp: true, email: false, digest: false })).toEqual(['IN_APP'])
    expect(channelLabels({ inApp: true, email: true, digest: true })).toEqual([
      'IN_APP',
      'EMAIL',
      'DIGEST',
    ])
  })
})

describe('renderNotification', () => {
  const event = (type: string, payload: Record<string, unknown> = {}) => ({
    id: 'e1',
    type: type as never,
    organizationId: 'org1',
    entityType: 'Task',
    entityId: 'task1',
    actorId: 'u1',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    payload,
  })

  it('renders every event type in the catalogue', () => {
    // A catalogue entry with no rendering would silently notify nobody, which is
    // the kind of gap that is only noticed when a user asks why they were not
    // told something.
    for (const type of EVENT_TYPES) {
      const rendered = renderNotification(event(type), 'acme')
      expect(rendered, `no rendering for ${type}`).not.toBeNull()
      expect(rendered!.title.length).toBeGreaterThan(0)
    }
  })

  it('uses the payload rather than looking the entity up', () => {
    const rendered = renderNotification(
      event('task.assigned', { actorName: 'Ada', title: 'Ship the thing' }),
      'acme',
    )

    expect(rendered?.title).toBe('Ada assigned you "Ship the thing"')
    expect(rendered?.href).toBe('/acme/tasks/task1')
  })

  it('degrades to a readable sentence when the payload is incomplete', () => {
    const rendered = renderNotification(event('task.assigned', {}), 'acme')
    expect(rendered?.title).toBe('Someone assigned you "a task"')
  })

  it('marks a mention high priority and a comment low', () => {
    expect(renderNotification(event('task.mentioned'), 'acme')?.priority).toBe('HIGH')
    expect(renderNotification(event('task.commented'), 'acme')?.priority).toBe('LOW')
  })
})

describe('renderEmail', () => {
  it('builds an absolute link from the relative href', () => {
    const rendered = renderNotification(
      {
        id: 'e1',
        type: 'task.assigned',
        organizationId: 'org1',
        entityType: 'Task',
        entityId: 'task1',
        actorId: 'u1',
        occurredAt: new Date(),
        payload: { actorName: 'Ada', title: 'Ship it' },
      },
      'acme',
    )!

    const email = renderEmail(rendered, 'Grace', 'https://nexus.example')

    expect(email.subject).toBe('Ada assigned you "Ship it"')
    expect(email.text).toContain('https://nexus.example/acme/tasks/task1')
    expect(email.text).toContain('Hello Grace,')
  })
})
