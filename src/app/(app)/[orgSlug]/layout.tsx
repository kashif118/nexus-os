import type { ReactNode } from 'react'

import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { listMyOrganizations } from '@/modules/organizations/queries'
import { AppShell } from '@/components/layout/app-shell'

/**
 * The tenant guard (docs/PLATFORM.md §H.3, layer 1).
 *
 * `requireCtxPage` resolves the slug to an ACTIVE membership for the signed-in
 * user before any child renders. A non-member gets 404, never 403 — a 403 would
 * confirm the organization exists.
 *
 * Everything below this layout can rely on `ctx`, and every query beneath it
 * runs through the org-scoped Prisma client.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug, `/${orgSlug}`)
  const organizations = await listMyOrganizations(ctx.userId)

  return (
    <AppShell
      org={{ slug: ctx.org.slug, name: ctx.org.name, logoUrl: ctx.org.logoUrl }}
      user={{ name: ctx.user.name, email: ctx.user.email }}
      organizations={organizations}
    >
      {children}
    </AppShell>
  )
}
