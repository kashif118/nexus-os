import { after } from 'next/server'

import { drainOutbox } from '@/kernel/events'

/**
 * Subscriber registration and scheduling.
 *
 * Lives in a module rather than the kernel because the kernel is not allowed to
 * know what listens to it. Every caller that emits an event calls
 * `scheduleDrain()` afterwards; the cron route calls `runDrain()` directly as
 * the safety net.
 */

let loaded = false

export async function loadSubscribers(): Promise<void> {
  if (loaded) return
  loaded = true

  const loaders: Array<() => Promise<unknown>> = [
    () => import('./subscriber'),
    () => import('./activity-subscriber'),
  ]

  await Promise.all(
    loaders.map(async (load) => {
      try {
        await load()
      } catch (error) {
        console.error('[events] failed to load a subscriber module', error)
      }
    }),
  )
}

export async function runDrain(limit = 50) {
  await loadSubscribers()
  return drainOutbox({ limit })
}

/**
 * Drain after the response has been sent.
 *
 * `after()` runs once the response is flushed, so nobody waits on somebody
 * else's notification. Outside a request scope — a script, a test — it falls
 * back to running inline rather than dropping the work.
 */
export function scheduleDrain(): void {
  const run = async () => {
    try {
      await runDrain()
    } catch (error) {
      console.error('[events] drain failed', error)
    }
  }

  try {
    after(run)
  } catch {
    void run()
  }
}
