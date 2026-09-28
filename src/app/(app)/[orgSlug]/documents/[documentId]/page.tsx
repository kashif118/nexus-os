import { Download } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { formatBytes } from '@/modules/documents/components/document-table'
import {
  DeleteDocumentButton,
  DocumentSettingsForm,
  RevokeGrantButton,
  ShareForm,
} from '@/modules/documents/components/document-forms'
import { getDocument, listFolders, listGrants, listShareTargets } from '@/modules/documents/queries'

export const metadata: Metadata = { title: 'Document' }

const ACCESS_REASON: Record<string, string> = {
  UPLOADER: 'You uploaded this document.',
  EXPLICIT_GRANT: 'It was shared with you.',
  ORGANIZATION_VISIBILITY: 'It is visible to everyone in the organization.',
  ORGANIZATION_READER: 'You can read every document in this organization.',
}

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; documentId: string }>
}) {
  const { orgSlug, documentId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let document: Awaited<ReturnType<typeof getDocument>>
  try {
    document = await getDocument(ctx, documentId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const [folders, grants] = await Promise.all([listFolders(ctx), listGrants(ctx, documentId)])

  // Sharing pickers only load when the viewer can actually share.
  const shareTargets = document.canShare ? await listShareTargets(ctx) : { people: [], teams: [] }

  const subjectLabel = (subjectType: string, subjectId: string): string => {
    if (subjectType === 'USER') {
      return shareTargets.people.find((person) => person.id === subjectId)?.name ?? 'A member'
    }
    if (subjectType === 'TEAM') {
      return shareTargets.teams.find((team) => team.id === subjectId)?.name ?? 'A team'
    }
    return ctx.roles.find((role) => role.id === subjectId)?.name ?? 'A role'
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title={document.name}
        description={
          <>
            {formatBytes(document.sizeBytes)} · {document.mimeType} · version {document.version}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant={
                document.visibility === 'PRIVATE'
                  ? 'warning'
                  : document.visibility === 'RESTRICTED'
                    ? 'info'
                    : 'neutral'
              }
            >
              {document.visibility.charAt(0) + document.visibility.slice(1).toLowerCase()}
            </Badge>
            <a
              href={`/api/orgs/${orgSlug}/documents/${document.id}/download`}
              className={buttonVariants({ size: 'sm' })}
            >
              <Download className="size-3.5" aria-hidden="true" />
              Download
            </a>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
              <CardDescription>{ACCESS_REASON[document.accessReason]}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {document.description ? (
                <p className="whitespace-pre-wrap">{document.description}</p>
              ) : (
                <p className="text-muted-foreground">No description.</p>
              )}
              <dl className="text-muted-foreground space-y-1 text-xs">
                <div className="flex justify-between gap-4">
                  <dt>Uploaded by</dt>
                  <dd>{document.uploadedBy?.user.name ?? 'Former member'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Added</dt>
                  <dd>{document.createdAt.toISOString().slice(0, 10)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Content check</dt>
                  <dd>
                    {document.scanStatus === 'SKIPPED'
                      ? 'Type and signature verified; no malware scanner configured'
                      : document.scanStatus.charAt(0) + document.scanStatus.slice(1).toLowerCase()}
                  </dd>
                </div>
                {document.folder ? (
                  <div className="flex justify-between gap-4">
                    <dt>Folder</dt>
                    <dd>
                      <Link
                        href={`/${orgSlug}/documents?folder=${document.folder.id}`}
                        className="hover:underline"
                      >
                        {document.folder.path}
                      </Link>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Versions</CardTitle>
              <CardDescription>
                Replacing a file keeps the previous bytes, so an older revision stays retrievable.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-border divide-y text-sm">
                {document.versions.map((version) => (
                  <li key={version.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="font-medium">Version {version.version}</p>
                      <p className="text-muted-foreground text-xs">
                        {version.createdAt.toISOString().slice(0, 10)} ·{' '}
                        {formatBytes(version.sizeBytes)} ·{' '}
                        {version.uploadedBy?.user.name ?? 'Former member'}
                      </p>
                    </div>
                    <a
                      href={`/api/orgs/${orgSlug}/documents/${document.id}/download?version=${version.id}`}
                      className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                    >
                      Download
                    </a>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {document.canEdit ? (
            <Card>
              <CardHeader>
                <CardTitle>Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <DocumentSettingsForm
                  orgSlug={orgSlug}
                  document={{
                    id: document.id,
                    name: document.name,
                    description: document.description,
                    folderId: document.folderId,
                    visibility: document.visibility,
                  }}
                  folders={folders.map((folder) => ({ id: folder.id, path: folder.path }))}
                  canChangeVisibility={document.canShare}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Shared with</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {grants.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {document.visibility === 'ORGANIZATION'
                    ? 'Everyone in the organization can already see this.'
                    : 'Nobody else yet.'}
                </p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {grants.map((grant) => (
                    <li key={grant.id} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {subjectLabel(grant.subjectType, grant.subjectId)}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {grant.access.charAt(0) + grant.access.slice(1).toLowerCase()}
                        </p>
                      </div>
                      {document.canShare ? (
                        <RevokeGrantButton
                          orgSlug={orgSlug}
                          documentId={document.id}
                          grantId={grant.id}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {document.canShare ? (
                <div className="border-t pt-3">
                  <ShareForm
                    orgSlug={orgSlug}
                    documentId={document.id}
                    people={shareTargets.people}
                    teams={shareTargets.teams}
                    roles={ctx.roles.map((role) => ({ id: role.id, name: role.name }))}
                  />
                </div>
              ) : null}
            </CardContent>
          </Card>

          {document.canDelete ? (
            <Card>
              <CardHeader>
                <CardTitle>Danger zone</CardTitle>
                <CardDescription>
                  Deleting removes it from every list. The stored file is purged by the retention
                  job, not immediately, so this stays recoverable for a while.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DeleteDocumentButton orgSlug={orgSlug} documentId={document.id} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
