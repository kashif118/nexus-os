import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/** Loading placeholder. Every async surface in the product uses this, never a spinner. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />
}
