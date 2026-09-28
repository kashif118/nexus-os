import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export function Textarea({ className, rows = 4, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      rows={rows}
      className={cn(
        'border-input bg-background placeholder:text-muted-foreground w-full rounded-md border px-3 py-2 text-sm shadow-[var(--shadow-sm)]',
        'aria-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
