import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { getRolePermissions, listAssignableRoles } from '@/modules/organizations/queries'

export const metadata: Metadata = { title: 'Roles and permissions' }

/**
 * Role inspector.
 *
 * Shows exactly which permissions each role carries, because "what can this
 * person actually do" must be answerable without reading the source. Editing
 * custom roles is not built yet; the seven system templates are immutable by
 * design, so there is nothing to edit here that would not be a lie.
 */
export default async function RolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ role?: string }>
}) {
  const { orgSlug } = await params
  const { role: selectedRoleId } = await searchParams
  const ctx = await requireCtxPage(orgSlug)

  // Reading the role matrix is itself privileged: it describes the security
  // model of the organization.
  if (!ctx.can('organization.roles.manage')) notFound()

  const roles = await listAssignableRoles(ctx)
  const activeId = selectedRoleId ?? roles[0]?.id
  const detail = activeId ? await getRolePermissions(ctx, activeId) : null

  type PermissionRow = NonNullable<typeof detail>['permissions'][number]
  const byModule = new Map<string, PermissionRow[]>()
  for (const permission of detail?.permissions ?? []) {
    const list = byModule.get(permission.module) ?? []
    list.push(permission)
    byModule.set(permission.module, list)
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Roles and permissions</h1>
        <p className="text-muted-foreground text-sm">
          Every permission a role carries. A denial always beats a grant, which is how external
          access stays contained.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Roles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {roles.map((role) => (
              <a
                key={role.id}
                href={`/${orgSlug}/settings/roles?role=${role.id}`}
                className={`block rounded-md px-2.5 py-2 text-sm transition-colors ${
                  role.id === activeId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{role.name}</span>
                  <span className="text-muted-foreground tabular text-xs">
                    {role._count.permissions}
                  </span>
                </span>
                {role.isSystem ? (
                  <span className="text-muted-foreground text-xs">System role</span>
                ) : null}
              </a>
            ))}
          </CardContent>
        </Card>

        {detail ? (
          <Card>
            <CardHeader>
              <CardTitle>{detail.role.name}</CardTitle>
              <CardDescription>
                {detail.permissions.length} permissions across {byModule.size} modules.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {[...byModule.entries()].map(([module, permissions]) => (
                <section key={module} className="space-y-2">
                  <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    {module}
                  </h2>
                  <ul className="space-y-1">
                    {permissions.map((permission) => (
                      <li key={permission.key} className="flex items-start justify-between gap-3">
                        <span className="text-sm">{permission.description}</span>
                        <Badge variant={permission.effect === 'DENY' ? 'destructive' : 'neutral'}>
                          {permission.effect === 'DENY' ? 'Denied' : 'Allowed'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
