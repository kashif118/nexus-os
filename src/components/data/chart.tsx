import type { ReactNode } from 'react'

/**
 * Charts, drawn as SVG with no charting library.
 *
 * A charting dependency brings a large bundle, a theming system that fights the
 * design tokens, and an API to keep up with — for two chart types. These are
 * about a hundred lines each, they render on the SERVER (so there is no client
 * JavaScript at all for a dashboard), and they inherit the palette because they
 * are drawn with `currentColor` and CSS variables.
 *
 * Accessibility is not optional here: every chart carries a text alternative
 * that states the same figures, because a picture of a number is not a number
 * to somebody using a screen reader.
 */

export interface SeriesPoint {
  label: string
  value: number
}

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 160
const PADDING = 4

/**
 * A sparkline-style area chart.
 *
 * Deliberately unlabelled on the axes: at dashboard size, axis labels are
 * unreadable and misleading. The figure people act on is the total beside it;
 * this shows the shape.
 */
export function TrendChart({
  points,
  format,
  ariaLabel,
}: {
  points: SeriesPoint[]
  format: (value: number) => string
  ariaLabel: string
}) {
  if (points.length === 0) {
    return <p className="text-muted-foreground text-xs">No data in this period.</p>
  }

  const values = points.map((point) => point.value)
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  // A flat series still needs a band to draw in, or every point lands on one
  // line and the chart reads as an error.
  const span = max - min || 1

  const step = points.length > 1 ? (VIEW_WIDTH - PADDING * 2) / (points.length - 1) : 0

  const coordinates = points.map((point, index) => {
    const x = PADDING + index * step
    const y = VIEW_HEIGHT - PADDING - ((point.value - min) / span) * (VIEW_HEIGHT - PADDING * 2)
    return { x, y }
  })

  const line = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ')

  const area = `${line} L${(PADDING + (points.length - 1) * step).toFixed(1)},${VIEW_HEIGHT - PADDING} L${PADDING},${VIEW_HEIGHT - PADDING} Z`

  const last = points.at(-1)
  const first = points[0]

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="text-primary h-24 w-full"
        role="img"
        aria-label={ariaLabel}
      >
        <path d={area} fill="currentColor" opacity={0.12} />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <figcaption className="text-muted-foreground flex justify-between text-xs">
        <span>
          {first?.label} · {format(first?.value ?? 0)}
        </span>
        <span>
          {last?.label} · {format(last?.value ?? 0)}
        </span>
      </figcaption>

      {/* The same data as text, for anyone the picture does not serve. */}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <tbody>
          {points.map((point) => (
            <tr key={point.label}>
              <th scope="row">{point.label}</th>
              <td>{format(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

/** A horizontal bar chart, for comparing a handful of named things. */
export function BarChart({
  points,
  format,
  ariaLabel,
  emptyLabel = 'Nothing to show.',
}: {
  points: SeriesPoint[]
  format: (value: number) => string
  ariaLabel: string
  emptyLabel?: string
}) {
  if (points.length === 0) {
    return <p className="text-muted-foreground text-xs">{emptyLabel}</p>
  }

  const max = Math.max(...points.map((point) => point.value), 1)

  return (
    <figure className="space-y-2" aria-label={ariaLabel}>
      <ul className="space-y-2">
        {points.map((point) => (
          <li key={point.label} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate">{point.label}</span>
              <span className="tabular text-muted-foreground">{format(point.value)}</span>
            </div>
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full"
                style={{ width: `${Math.max(2, Math.round((point.value / max) * 100))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </figure>
  )
}

/** A change indicator that knows which direction is good. */
export function ChangeBadge({
  changePercent,
  higherIsBetter,
}: {
  changePercent: number | null
  higherIsBetter: boolean
}): ReactNode {
  if (changePercent === null) {
    return <span className="text-muted-foreground text-xs">no comparison</span>
  }

  if (changePercent === 0) {
    return <span className="text-muted-foreground text-xs">unchanged</span>
  }

  const rising = changePercent > 0
  const good = rising === higherIsBetter

  return (
    <span
      className={`text-xs font-medium ${good ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
    >
      {rising ? '+' : ''}
      {changePercent}%
    </span>
  )
}
