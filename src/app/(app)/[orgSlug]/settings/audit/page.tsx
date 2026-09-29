import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EmptyState, PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { auditActions, listAuditLog } from '@/modules/security/queries'

export const metadata: Metadata = { title: 'Audit log' }

/**
 * The audit log.
 *
 * Append-only and never edited, so this page is a reader with filters and
 * nothing else. There is no delete, because an audit log you can tidy up is not
 * an audit log.
 */
export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const resolved = await searchParams
  const action = Array.isArray(resolved.action) ? resolved.action[0] : resolved.action

  let entries: Awaited<ReturnType<typeof listAuditLog>>
  let actions: string[]

  try {
    ;[entries, actions] = await Promise.all([listAuditLog(ctx, { action }), auditActions(ctx)])
  } catch (error) {
    if (isAppError(error) && error.code === 'FORBIDDEN') notFound()
    throw error
  }

  // Group the actions by module, so a list of a hundred keys is navigable.
  const modules = [...new Set(actions.map((entry) => entry.split('.')[0] ?? entry))].sort()

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="Audit log"
        description="Every consequential action, append-only. Nothing here can be edited or removed."
      />

      <nav className="flex flex-wrap gap-1 text-xs" aria-label="Filter by module">
        <Link
          href={`/${orgSlug}/settings/audit`}
          className={`rounded-md px-2 py-1 ${!action ? 'bg-accent' : 'hover:bg-accent/60'}`}
        >
          Everything
        </Link>
        {modules.map((module) => (
          <Link
            key={module}
            href={`/${orgSlug}/settings/audit?action=${module}`}
            className={`rounded-md px-2 py-1 ${action === module ? 'bg-accent' : 'hover:bg-accent/60'}`}
          >
            {module}
          </Link>
        ))}
      </nav>

      <Card>
        <CardContent className="pt-6">
          {entries.length === 0 ? (
            <EmptyState
              title="Nothing recorded"
              description="Actions appear here as they happen."
            />
          ) : (
            <ul className="divide-border divide-y text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="space-y-0.5 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <code className="font-mono text-xs">{entry.action}</code>
                      {entry.actorType !== 'USER' ? (
                        <Badge variant="neutral">{entry.actorType.toLowerCase()}</Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {entry.createdAt.toISOString().replace('T', ' ').slice(0, 19)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {entry.actorName}
                    {entry.entityType ? ` · ${entry.entityType}` : ''}
                    {entry.ip ? ` · ${entry.ip}` : ''}
                  </p>
                  {entry.metadata && Object.keys(entry.metadata as object).length > 0 ? (
                    <p className="text-muted-foreground font-mono text-xs">
                      {JSON.stringify(entry.metadata)}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
