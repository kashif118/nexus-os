'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner } from 'sonner'

/**
 * Toast host.
 *
 * Mounted once in the root layout. Toasts report the OUTCOME of an action the
 * user took; they never carry information the user needs to keep, which belongs
 * on the page itself.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group rounded-md border bg-card text-card-foreground shadow-[var(--shadow-lg)] text-sm',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          error: 'border-destructive/30',
          success: 'border-success/30',
        },
      }}
    />
  )
}

export { toast } from 'sonner'
