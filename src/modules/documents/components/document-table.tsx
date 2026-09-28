'use client'

import { DataTable, type Column } from '@/components/data/data-table'
import { Badge } from '@/components/ui/badge'

/** Human-readable size. Binary units, because storage quotas are quoted that way. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export interface DocumentRow {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  version: number
  visibility: string
  scanStatus: string
  createdAt: Date
  folder: { id: string; name: string; path: string } | null
  uploadedBy: { id: string; user: { name: string } } | null
}

const visibilityTone = (visibility: string) =>
  visibility === 'PRIVATE' ? 'warning' : visibility === 'RESTRICTED' ? 'info' : 'neutral'

export function DocumentTable({
  orgSlug,
  rows,
  pagination,
  sort,
}: {
  orgSlug: string
  rows: DocumentRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
}) {
  const columns: Column<DocumentRow>[] = [
    { id: 'name', header: 'Name', sortable: true, cell: (row) => row.name },
    {
      id: 'visibility',
      header: 'Visibility',
      cell: (row) => (
        <Badge variant={visibilityTone(row.visibility)}>
          {row.visibility.charAt(0) + row.visibility.slice(1).toLowerCase()}
        </Badge>
      ),
    },
    {
      id: 'folder',
      header: 'Folder',
      cell: (row) => row.folder?.path ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'uploadedBy',
      header: 'Uploaded by',
      cell: (row) =>
        row.uploadedBy?.user.name ?? <span className="text-muted-foreground">Former member</span>,
    },
    {
      id: 'sizeBytes',
      header: 'Size',
      sortable: true,
      numeric: true,
      cell: (row) => formatBytes(row.sizeBytes),
    },
    {
      id: 'createdAt',
      header: 'Added',
      sortable: true,
      cell: (row) => row.createdAt.toISOString().slice(0, 10),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `/${orgSlug}/documents/${row.id}`}
      emptyTitle="No documents"
      emptyDescription="Files you upload appear here, with the visibility you chose."
    />
  )
}
