'use client'

import { DataTable, type Column } from '@/components/data/data-table'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/money'

/**
 * CRM list tables.
 *
 * Client components only because DataTable reads and writes the URL for sorting
 * and pagination; the rows themselves are fetched on the server and passed in
 * already narrowed to a DTO.
 */

export interface CompanyRow {
  id: string
  name: string
  domain: string | null
  industry: string | null
  createdAt: Date
  owner: { user: { name: string } } | null
  _count: { contacts: number; deals: number }
}

export function CompanyTable({
  orgSlug,
  rows,
  pagination,
  sort,
}: {
  orgSlug: string
  rows: CompanyRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
}) {
  const columns: Column<CompanyRow>[] = [
    { id: 'name', header: 'Company', sortable: true, cell: (row) => row.name },
    {
      id: 'industry',
      header: 'Industry',
      cell: (row) => row.industry ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'domain',
      header: 'Domain',
      cell: (row) => row.domain ?? <span className="text-muted-foreground">—</span>,
    },
    { id: 'contacts', header: 'Contacts', numeric: true, cell: (row) => row._count.contacts },
    { id: 'deals', header: 'Deals', numeric: true, cell: (row) => row._count.deals },
    {
      id: 'owner',
      header: 'Owner',
      cell: (row) =>
        row.owner?.user.name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `/${orgSlug}/crm/companies/${row.id}`}
      emptyTitle="No companies yet"
      emptyDescription="Companies are the organizations you sell to and deliver for."
    />
  )
}

export interface ContactRow {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  position: string | null
  company: { id: string; name: string } | null
  owner: { user: { name: string } } | null
}

export function ContactTable({
  orgSlug,
  rows,
  pagination,
  sort,
}: {
  orgSlug: string
  rows: ContactRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
}) {
  const columns: Column<ContactRow>[] = [
    {
      id: 'lastName',
      header: 'Name',
      sortable: true,
      cell: (row) => `${row.firstName} ${row.lastName}`,
    },
    {
      id: 'company',
      header: 'Company',
      cell: (row) => row.company?.name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'position',
      header: 'Position',
      cell: (row) => row.position ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'email',
      header: 'Email',
      cell: (row) => row.email ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'owner',
      header: 'Owner',
      cell: (row) =>
        row.owner?.user.name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `/${orgSlug}/crm/contacts/${row.id}`}
      emptyTitle="No contacts yet"
      emptyDescription="Contacts are the people you deal with at each company."
    />
  )
}

export interface LeadRow {
  id: string
  name: string
  email: string | null
  companyName: string | null
  source: string
  status: string
  score: number
  convertedAt: Date | null
  owner: { user: { name: string } } | null
}

const LEAD_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'destructive'> = {
  NEW: 'info',
  CONTACTED: 'neutral',
  QUALIFIED: 'success',
  UNQUALIFIED: 'destructive',
  CONVERTED: 'success',
}

export function LeadTable({
  orgSlug,
  rows,
  pagination,
  sort,
}: {
  orgSlug: string
  rows: LeadRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
}) {
  const columns: Column<LeadRow>[] = [
    { id: 'name', header: 'Lead', sortable: true, cell: (row) => row.name },
    {
      id: 'companyName',
      header: 'Company',
      cell: (row) => row.companyName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (row) => (
        <Badge variant={LEAD_TONE[row.status] ?? 'neutral'}>{titleCase(row.status)}</Badge>
      ),
    },
    { id: 'source', header: 'Source', cell: (row) => titleCase(row.source) },
    { id: 'score', header: 'Score', sortable: true, numeric: true, cell: (row) => row.score },
    {
      id: 'owner',
      header: 'Owner',
      cell: (row) =>
        row.owner?.user.name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `/${orgSlug}/crm/leads/${row.id}`}
      emptyTitle="No leads yet"
      emptyDescription="Leads are enquiries you have not yet qualified."
    />
  )
}

export interface DealRow {
  id: string
  title: string
  valueMinor: bigint
  currency: string
  status: string
  expectedCloseDate: Date | null
  stage: { id: string; name: string; type: string }
  company: { id: string; name: string } | null
  owner: { user: { name: string } } | null
}

export function DealTable({
  orgSlug,
  rows,
  pagination,
  sort,
  canSeeValue,
}: {
  orgSlug: string
  rows: DealRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
  canSeeValue: boolean
}) {
  const columns: Column<DealRow>[] = [
    { id: 'title', header: 'Deal', sortable: true, cell: (row) => row.title },
    {
      id: 'company',
      header: 'Company',
      cell: (row) => row.company?.name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'stage',
      header: 'Stage',
      cell: (row) => <Badge variant="neutral">{row.stage.name}</Badge>,
    },
    // Deal value is a separate permission: a member may work the pipeline
    // without seeing what each deal is worth.
    ...(canSeeValue
      ? [
          {
            id: 'valueMinor',
            header: 'Value',
            sortable: true,
            numeric: true,
            cell: (row: DealRow) => formatMoney(row.valueMinor, row.currency),
          } satisfies Column<DealRow>,
        ]
      : []),
    {
      id: 'expectedCloseDate',
      header: 'Expected close',
      sortable: true,
      cell: (row) =>
        row.expectedCloseDate ? (
          row.expectedCloseDate.toISOString().slice(0, 10)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'owner',
      header: 'Owner',
      cell: (row) =>
        row.owner?.user.name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `/${orgSlug}/crm/deals/${row.id}`}
      emptyTitle="No deals yet"
      emptyDescription="A deal is an opportunity moving through a pipeline."
    />
  )
}

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
