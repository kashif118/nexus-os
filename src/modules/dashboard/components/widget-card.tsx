import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ResolvedWidget } from '../registry'

/**
 * Renders one widget value.
 *
 * A widget whose resolver failed shows a quiet inline message rather than
 * disappearing: a missing card is indistinguishable from a zero, and on an
 * executive dashboard that difference matters.
 */
export function WidgetCard({ widget }: { widget: ResolvedWidget }) {
  const { definition, value, error } = widget

  const spanClass =
    definition.span === 12
      ? 'sm:col-span-12'
      : definition.span === 6
        ? 'sm:col-span-6'
        : definition.span === 4
          ? 'sm:col-span-6 lg:col-span-4'
          : 'sm:col-span-6 lg:col-span-3'

  return (
    <Card className={cn('col-span-12', spanClass)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {definition.title}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {error ? (
          <p className="text-muted-foreground text-sm">{error}</p>
        ) : value?.kind === 'stat' ? (
          <div className="space-y-1">
            {value.href ? (
              <Link href={value.href} className="hover:underline">
                <p className="tabular text-2xl font-semibold">{value.value}</p>
              </Link>
            ) : (
              <p className="tabular text-2xl font-semibold">{value.value}</p>
            )}
            {value.detail ? <p className="text-muted-foreground text-xs">{value.detail}</p> : null}
            {value.trend ? (
              <p className={cn('text-xs', value.trend.good ? 'text-success' : 'text-destructive')}>
                {value.trend.label}
              </p>
            ) : null}
          </div>
        ) : value?.kind === 'list' ? (
          value.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{value.emptyLabel}</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {value.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    {item.href ? (
                      <Link href={item.href} className="truncate font-medium hover:underline">
                        {item.title}
                      </Link>
                    ) : (
                      <p className="truncate font-medium">{item.title}</p>
                    )}
                    {item.meta ? (
                      <p className="text-muted-foreground truncate text-xs">{item.meta}</p>
                    ) : null}
                  </div>
                  {item.badge ? <Badge variant={item.badge.tone}>{item.badge.label}</Badge> : null}
                </li>
              ))}
            </ul>
          )
        ) : value?.kind === 'breakdown' ? (
          value.total === 0 ? (
            <p className="text-muted-foreground text-sm">{value.emptyLabel}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {value.segments.map((segment) => (
                <li key={segment.label} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span>{segment.label}</span>
                    <span className="tabular text-muted-foreground">{segment.value}</span>
                  </div>
                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${Math.round((segment.value / value.total) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardContent>
    </Card>
  )
}
