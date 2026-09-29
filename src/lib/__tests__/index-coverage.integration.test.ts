import { describe, expect, it } from 'vitest'

import { getSystemDb, TENANT_MODELS } from '@/lib/db'

/**
 * Index coverage for tenant scoping.
 *
 * Every query a repository issues carries `organizationId`, because the scoped
 * client puts it there. That makes one structural property decisive for
 * performance at any real data volume: for each tenant table there must be an
 * index whose FIRST column is `organizationId`. Without it, a query for one
 * organization's rows reads every organization's rows and filters afterwards —
 * fine at a hundred rows, ruinous at a million, and invisible in development.
 *
 * Leading column matters. A composite index on `(status, organizationId)` does
 * not serve `WHERE organizationId = ?` the way `(organizationId, status)` does,
 * so the test checks position rather than mere presence.
 *
 * This is the performance counterpart to `tenant-registry.test.ts`, which
 * checks that every such table is scoped at all. Together: a new tenant table
 * cannot ship unscoped, untested, or unindexed.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

interface IndexRow {
  table_name: string
  index_name: string
  first_column: string
}

describe.skipIf(!hasDatabase)('tenant index coverage', () => {
  it('leads an index with organizationId on every tenant table', async () => {
    const rows = await getSystemDb().$queryRaw<IndexRow[]>`
      SELECT t.relname  AS table_name,
             c.relname  AS index_name,
             a.attname  AS first_column
      FROM pg_index i
      JOIN pg_class      t ON t.oid = i.indrelid
      JOIN pg_class      c ON c.oid = i.indexrelid
      JOIN pg_namespace  n ON n.oid = t.relnamespace
      JOIN pg_attribute  a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
      WHERE n.nspname = 'public'
    `

    const leading = new Map<string, string[]>()
    for (const row of rows) {
      if (row.first_column !== 'organizationId') continue
      const existing = leading.get(row.table_name) ?? []
      existing.push(row.index_name)
      leading.set(row.table_name, existing)
    }

    const missing = [...TENANT_MODELS].filter((model) => !leading.has(model)).sort()

    expect(
      missing,
      `these tenant tables have no index leading with organizationId, so every ` +
        `scoped read on them scans the whole table: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('indexes the columns the list screens actually sort and filter on', async () => {
    /*
     * The hot paths, named explicitly: the equality filters each default list
     * view issues. An index serves them only if those columns are its LEADING
     * columns, in any order among themselves — Postgres can use a multicolumn
     * index for equality on a prefix, and not for a column buried behind one
     * the query does not constrain.
     *
     * The notification counter is the interesting case. Its index leads with
     * the recipient rather than the organization, and that is correct: one
     * membership is far more selective than one organization, and the query
     * always names both.
     */
    const expected: Array<{ table: string; filters: string[] }> = [
      { table: 'Task', filters: ['organizationId', 'status'] },
      { table: 'Invoice', filters: ['organizationId', 'status'] },
      { table: 'Project', filters: ['organizationId', 'status'] },
      { table: 'Deal', filters: ['organizationId', 'stageId'] },
      { table: 'Document', filters: ['organizationId', 'folderId'] },
      { table: 'AuditLog', filters: ['organizationId', 'createdAt'] },
      { table: 'Notification', filters: ['recipientMembershipId', 'readAt'] },
    ]

    const rows = await getSystemDb().$queryRaw<Array<{ table_name: string; columns: string }>>`
      SELECT t.relname AS table_name,
             string_agg(a.attname, ',' ORDER BY k.ordinality) AS columns
      FROM pg_index i
      JOIN pg_class     t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON TRUE
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = 'public'
      GROUP BY t.relname, i.indexrelid
    `

    const missing = expected.filter(({ table, filters }) => {
      const indexes = rows.filter((row) => row.table_name === table)

      return !indexes.some((row) => {
        const prefix = row.columns.split(',').slice(0, filters.length)
        return (
          prefix.length === filters.length && filters.every((column) => prefix.includes(column))
        )
      })
    })

    expect(
      missing.map(({ table, filters }) => `${table}(${filters.join(', ')})`),
      'these list filters have no index leading with exactly those columns',
    ).toEqual([])
  })
})
