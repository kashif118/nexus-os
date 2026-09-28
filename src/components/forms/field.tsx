import type { ComponentProps, ReactNode } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * One labelled input with its error and hint, wired for accessibility:
 * `aria-invalid` and `aria-describedby` point at the message so a screen reader
 * announces the problem, not just the styling.
 */
export function Field({
  name,
  label,
  errors,
  hint,
  className,
  ...props
}: ComponentProps<'input'> & {
  name: string
  label: string
  errors?: string[] | undefined
  hint?: ReactNode
}) {
  const hasError = Boolean(errors?.length)
  const errorId = `${name}-error`
  const hintId = `${name}-hint`

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        aria-invalid={hasError}
        aria-describedby={cn(hasError && errorId, hint && hintId) || undefined}
        {...props}
      />
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="text-destructive text-xs">
          {errors?.join(' ')}
        </p>
      ) : null}
    </div>
  )
}
