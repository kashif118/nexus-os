'use client'

import { DataTable, type Column } from '@/components/data/data-table'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/money'

/**
 * Finance list tables.
 *
 * Money is formatted from the stored minor units; nothing here recomputes a
 * total. The numbers on screen are the numbers in the ledger.
 */

const title = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')

const invoiceTone = (status: string) =>
  status === 'PAID'
    ? 'success'
    : status === 'OVERDUE'
      ? 'destructive'
      : status === 'CANCELLED'
        ? 'neutral'
        : 'neutral'

export interface InvoiceRow {
  id: string
  number: string
  status: string
  issueDate: Date
  dueDate: Date
  currency: string
  totalMinor: bigint
  amountPaidMinor: bigint
  balanceMinor: bigint
  company: { id: string; name: string }
  project: { id: string; key: string } | null
}

export function InvoiceTable({
  orgSlug,
  rows,
  pagination,
  sort,
}: {
  orgSlug: string
  rows: InvoiceRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
}) {
  const columns: Column<InvoiceRow>[] = [
    { id: 'number', header: 'Number', sortable: true, cell: (row) => row.number },
    { id: 'company', header: 'Client', cell: (row) => row.company.name },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (row) => <Badge variant={invoiceTone(row.status)}>{title(row.status)}</Badge>,
    },
    {
      id: 'issueDate',
      header: 'Issued',
      sortable: true,
      cell: (row) => row.issueDate.toISOString().slice(0, 10),
    },
    {
      id: 'dueDate',
      header: 'Due',
      sortable: true,
      cell: (row) => row.dueDate.toISOString().slice(0, 10),
    },
    {
      id: 'totalMinor',
      header: 'Total',
      sortable: true,
      numeric: true,
      cell: (row) => formatMoney(row.totalMinor, row.currency),
    },
    {
      id: 'balanceMinor',
      header: 'Balance',
      numeric: true,
      cell: (row) => formatMoney(row.balanceMinor, row.currency),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `/${orgSlug}/finance/invoices/${row.id}`}
      emptyTitle="No invoices yet"
      emptyDescription="Raise an invoice against a client to start tracking what you are owed."
    />
  )
}

export interface ExpenseRow {
  id: string
  vendor: string | null
  description: string | null
  amountMinor: bigint
  taxMinor: bigint
  currency: string
  incurredOn: Date
  status: string
  category: { id: string; name: string } | null
  project: { id: string; key: string } | null
  submittedBy: { user: { name: string } } | null
}

export function ExpenseTable({
  rows,
  pagination,
  sort,
  selectHrefBase,
}: {
  rows: ExpenseRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
  /** Prefix ending in ? or &; the row id is appended as expense=<id>. */
  selectHrefBase: string
}) {
  const columns: Column<ExpenseRow>[] = [
    {
      id: 'incurredOn',
      header: 'Date',
      sortable: true,
      cell: (row) => row.incurredOn.toISOString().slice(0, 10),
    },
    {
      id: 'vendor',
      header: 'Vendor',
      cell: (row) => row.vendor ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'category',
      header: 'Category',
      cell: (row) => row.category?.name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'submittedBy',
      header: 'Claimant',
      cell: (row) =>
        row.submittedBy?.user.name ?? <span className="text-muted-foreground">Removed</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (row) => (
        <Badge
          variant={
            row.status === 'APPROVED' || row.status === 'REIMBURSED'
              ? 'success'
              : row.status === 'REJECTED'
                ? 'destructive'
                : 'neutral'
          }
        >
          {title(row.status)}
        </Badge>
      ),
    },
    {
      id: 'amountMinor',
      header: 'Amount',
      sortable: true,
      numeric: true,
      cell: (row) => formatMoney(row.amountMinor + row.taxMinor, row.currency),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `${selectHrefBase}expense=${row.id}`}
      emptyTitle="No expenses"
      emptyDescription="Claims you file appear here, with their approval state."
    />
  )
}
