/**
 * The event kernel: a catalogue, an emitter and a dispatcher.
 *
 * Note what is NOT here: the list of subscribers. The kernel may not import a
 * module (the layering rule in `eslint.config.mjs`), and that constraint is
 * doing real work — it keeps the event machinery ignorant of what listens to
 * it, so a module can be deleted without the kernel knowing. Registration and
 * scheduling live in `modules/notifications/dispatch.ts`.
 */
export {
  EVENT_CATALOGUE,
  EVENT_GROUPS,
  EVENT_TYPES,
  eventDefinition,
  isEventType,
  type EventGroup,
  type EventType,
} from './catalogue'

export { emitEvent, emitEventSafely, type EmitInput } from './emit'

export {
  drainOutbox,
  registerSubscriber,
  resetSubscribers,
  subscriberNames,
  type DomainEvent,
  type DrainResult,
  type Subscriber,
} from './dispatcher'
