'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Go to the record that was just created.
 *
 * A create form that stays put after a successful save is a duplicate waiting
 * to happen: the fields are still filled, the button still works, and a second
 * click makes a second record. Every create action already returns the new id
 * for exactly this reason.
 *
 * `basePath` is a string rather than a callback so the effect's dependencies
 * are stable values — a callback would be a new function on every render and
 * would either re-fire the navigation or need the lint rule silenced.
 *
 * An edit action returns no id, so an edit form using the same component never
 * navigates.
 */
export function useCreatedRedirect(
  state: { ok: true; data: { id?: string } } | { ok: false } | null,
  basePath: string,
): void {
  const router = useRouter()
  const id = state?.ok ? state.data.id : undefined

  useEffect(() => {
    if (id) router.push(`${basePath}/${id}`)
  }, [id, basePath, router])
}
