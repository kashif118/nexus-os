import type { Ctx } from '@/kernel/tenancy/ctx'

import './metrics'

import { getMetric, metricsFor, type MetricDefinition, type MetricPoint } from './metrics'
import { isPeriodKey, percentChange, previousRange, resolveRange, type PeriodKey } from './periods'
import * as repository from './repository'

/**
 * Analytics.
 *
 * Every figure is computed live from the source rows. A metric the caller may
 * not see is never computed, so the number does not exist in the response for
 * somebody to find in a payload.
 */

export interface MetricResult {
  key: string
  label: string
  description: string
  unit: string
  value: number
  valueMinor: bigint | null
  previousValue: number
  changePercent: number | null
  higherIsBetter: boolean
  drilldown: string | null
}

export interface AnalyticsResult {
  period: PeriodKey
  rangeLabel: string
  from: Date
  to: Date
  currency: string
  metrics: MetricResult[]
  series: Array<{ key: string; label: string; unit: string; points: MetricPoint[] }>
}

export async function getAnalytics(
  ctx: Ctx,
  options: { period?: string; orgSlug?: string } = {},
): Promise<AnalyticsResult> {
  // Analytics is a permission of its own: seeing the underlying records does
  // not imply being allowed to see them aggregated across the organization.
  ctx.requireAny(['analytics.view.org', 'analytics.view.team', 'analytics.view.own'])

  const period: PeriodKey = options.period && isPeriodKey(options.period) ? options.period : '30d'

  const range = resolveRange(period)
  const previous = previousRange(range)
  const available = metricsFor(ctx)
  const orgSlug = options.orgSlug ?? ctx.orgSlug

  const metrics = await Promise.all(
    available.map(async (metric): Promise<MetricResult> => {
      const [current, before] = await Promise.all([
        metric.total(ctx, range),
        metric.total(ctx, previous),
      ])

      return {
        key: metric.key,
        label: metric.label,
        description: metric.description,
        unit: metric.unit,
        value: current.value,
        valueMinor: current.valueMinor ?? null,
        previousValue: before.value,
        changePercent: percentChange(current.value, before.value),
        higherIsBetter: metric.higherIsBetter,
        drilldown: metric.drilldown?.(orgSlug) ?? null,
      }
    }),
  )

  const series = await Promise.all(
    available
      .filter(
        (
          metric,
        ): metric is MetricDefinition & { series: NonNullable<MetricDefinition['series']> } =>
          Boolean(metric.series),
      )
      .map(async (metric) => ({
        key: metric.key,
        label: metric.label,
        unit: metric.unit,
        points: await metric.series(ctx, range),
      })),
  )

  return {
    period,
    rangeLabel: range.label,
    from: range.from,
    to: range.to,
    currency: ctx.org.currency,
    metrics,
    series,
  }
}

/**
 * Cache one metric's value for a period.
 *
 * Written FROM the live computation, never read back in place of it. The cache
 * exists so a long history does not re-aggregate on every page load; a stale
 * entry is therefore a performance artefact, not a wrong number.
 */
export async function snapshotMetric(
  ctx: Ctx,
  metricKey: string,
  period: PeriodKey = '30d',
): Promise<void> {
  const metric = getMetric(metricKey)
  if (!metric) return
  if (!metric.requires.every((permission) => ctx.can(permission))) return

  const range = resolveRange(period)
  const result = await metric.total(ctx, range)

  await repository.writeSnapshot(ctx, metricKey, range.from, {
    valueNumeric: result.value,
    valueMinor: result.valueMinor ?? null,
    currency: result.valueMinor === undefined ? null : ctx.org.currency,
  })
}

export const availableMetrics = (ctx: Ctx) =>
  metricsFor(ctx).map((metric) => ({
    key: metric.key,
    label: metric.label,
    unit: metric.unit,
  }))
