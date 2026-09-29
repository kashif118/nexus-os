import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { parseListParams } from '@/kernel/validation/list-params'
import { SearchInput } from '@/modules/crm/components/search-input'
import { formatBytes } from '@/lib/format'
import { DocumentTable } from '@/modules/documents/components/document-table'
import { FolderForm } from '@/modules/documents/components/document-forms'
import { UploadPanel } from '@/modules/documents/components/upload-panel'
import { getStorageSummary, listDocuments, listFolders } from '@/modules/documents/queries'
import { DOCUMENT_SORT_FIELDS } from '@/modules/documents/schema'

export const metadata: Metadata = { title: 'Documents' }

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)
  if (!ctx.canAny(['document.read.any', 'document.read.scoped'])) notFound()

  const resolved = await searchParams
  const listParams = parseListParams(resolved, {
    sortableFields: DOCUMENT_SORT_FIELDS,
    defaultSort: 'createdAt',
    defaultDirection: 'desc',
  })

  const folderId = Array.isArray(resolved.folder) ? resolved.folder[0] : resolved.folder

  const [page, folders, storage] = await Promise.all([
    listDocuments(ctx, listParams, { folderId }),
    listFolders(ctx),
    getStorageSummary(ctx),
  ])

  const activeFolder = folders.find((folder) => folder.id === folderId)

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Documents"
        description={`${storage.count} file${storage.count === 1 ? '' : 's'} · ${formatBytes(storage.bytes)} stored`}
      />

      <div className="grid gap-6 lg:grid-cols-4">
        <aside className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Folders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <nav className="space-y-1 text-sm">
                <Link
                  href={`/${orgSlug}/documents`}
                  className={`block rounded-md px-2 py-1 ${!folderId ? 'bg-accent' : 'hover:bg-accent/60'}`}
                >
                  All documents
                </Link>
                {folders.map((folder) => (
                  <Link
                    key={folder.id}
                    href={`/${orgSlug}/documents?folder=${folder.id}`}
                    className={`block truncate rounded-md px-2 py-1 ${
                      folderId === folder.id ? 'bg-accent' : 'hover:bg-accent/60'
                    }`}
                    style={{
                      paddingLeft: `${0.5 + (folder.path.split('/').length - 2) * 0.75}rem`,
                    }}
                  >
                    {folder.name}
                    <span className="text-muted-foreground ml-1 text-xs">
                      {folder._count.documents}
                    </span>
                  </Link>
                ))}
              </nav>

              {ctx.can('document.folder.manage') ? (
                <div className="border-t pt-3">
                  <FolderForm
                    orgSlug={orgSlug}
                    folders={folders.map((folder) => ({ id: folder.id, path: folder.path }))}
                  />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>

        <div className="space-y-4 lg:col-span-3">
          {ctx.can('document.upload') ? (
            <Card>
              <CardHeader>
                <CardTitle>Upload</CardTitle>
                <CardDescription>
                  Files are stored privately. Nothing here is reachable by URL without a permission
                  check.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UploadPanel
                  orgSlug={orgSlug}
                  folders={folders.map((folder) => ({
                    id: folder.id,
                    name: folder.name,
                    path: folder.path,
                  }))}
                  currentFolderId={folderId}
                />
              </CardContent>
            </Card>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <SearchInput placeholder="Search documents…" />
            {activeFolder ? (
              <span className="text-muted-foreground text-xs">In {activeFolder.path}</span>
            ) : null}
          </div>

          <DocumentTable
            orgSlug={orgSlug}
            rows={page.items}
            pagination={{ page: page.page, pageSize: page.pageSize, total: page.total }}
            sort={listParams.sort}
          />
        </div>
      </div>
    </div>
  )
}
