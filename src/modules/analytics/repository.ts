import type { Ctx } from '@/kernel/tenancy/ctx'
import { getSystemDb } from '@/lib/db'

/**
 * The snapshot cache.
 *
 * The only place analytics touches the database outside a metric's own
 * computation. Metrics read their source tables through `ctx.db`; this writes
 * and reads the cache of what they computed.
 */

export interface SnapshotValues {
  valueNumeric: number
  valueMinor: bigint | null
  currency: string | null
}

export async function findSnapshot(organizationId: string, metric: string, periodStart: Date) {
  return getSystemDb().metricSnapshot.findFirst({
    where: {
      organizationId,
      metric,
      dimension: null,
      dimensionId: null,
      periodType: 'DAY',
      periodStart,
    },
    select: { id: true, valueNumeric: true, valueMinor: true, computedAt: true },
  })
}

/**
 * Write a snapshot.
 *
 * Read-then-write rather than an upsert: `dimension` and `dimensionId` are
 * nullable parts of the unique key, and Prisma cannot look up a compound unique
 * containing a null. Last-writer-wins is the right outcome for a cache anyway.
 */
export async function writeSnapshot(
  ctx: Ctx,
  metric: string,
  periodStart: Date,
  values: SnapshotValues,
): Promise<void> {
  const db = getSystemDb()
  const existing = await findSnapshot(ctx.orgId, metric, periodStart)

  if (existing) {
    await db.metricSnapshot.update({
      where: { id: existing.id },
      data: { ...values, computedAt: new Date() },
    })
    return
  }

  await db.metricSnapshot.create({
    data: {
      organizationId: ctx.orgId,
      metric,
      periodType: 'DAY',
      periodStart,
      ...values,
    },
  })
}
