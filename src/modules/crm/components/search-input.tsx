'use client'

import { Search } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useTransition } from 'react'

import { Input } from '@/components/ui/input'

/**
 * List search.
 *
 * Writes to the URL rather than local state, so the search runs in SQL on the
 * server and the result is a shareable, back-button-safe link. Debounced so
 * typing does not fire a query per keystroke.
 *
 * The input is UNCONTROLLED, keyed on the URL value. That removes the usual
 * "mirror the prop into state" effect — which causes a cascading render — while
 * still picking up an external change such as the back button, because a new key
 * remounts the field.
 */
export function SearchInput({ placeholder = 'Search…' }: { placeholder?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  const current = searchParams.get('q') ?? ''
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  function onChange(next: string) {
    clearTimeout(timer.current)

    timer.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString())
      if (next.trim()) params.set('q', next.trim())
      else params.delete('q')
      // A new search invalidates the current page number.
      params.delete('page')

      startTransition(() => router.replace(`${pathname}?${params.toString()}`))
    }, 300)
  }

  return (
    <div className="relative max-w-sm">
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        key={current}
        type="search"
        defaultValue={current}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-8"
      />
    </div>
  )
}
