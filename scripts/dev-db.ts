/**
 * Local PostgreSQL for development and testing.
 *
 * Runs a real PostgreSQL server from a prebuilt binary in a local data
 * directory — no Docker, no system install, no administrator rights. The point
 * is that integration and end-to-end tests run against genuine Postgres
 * semantics (enums, unique indexes, foreign keys) rather than a mock.
 *
 *   npx tsx scripts/dev-db.ts start
 *   npx tsx scripts/dev-db.ts stop
 *
 * CI uses a Postgres service container instead; this is purely a local
 * convenience.
 */
import { resolve } from 'node:path'

import EmbeddedPostgres from 'embedded-postgres'
import { Client } from 'pg'

const DATA_DIR = resolve(process.cwd(), '.postgres-data')
const PORT = Number(process.env.DEV_DB_PORT ?? 55432)
const USER = 'postgres'
const PASSWORD = 'postgres'
const DATABASE = 'nexus_os'

function createServer() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  })
}

async function start() {
  const server = createServer()

  const { existsSync } = await import('node:fs')
  if (!existsSync(DATA_DIR)) {
    console.log('Initialising cluster in .postgres-data …')
    await server.initialise()
  }

  await server.start()

  /**
   * Create the database with an explicit UTF-8 encoding.
   *
   * `initdb` picks the encoding from the host locale, which on a Windows
   * machine is WIN1252 — and then storing any character outside it fails with
   * "has no equivalent in encoding WIN1252". That is not a theoretical problem:
   * an accented name, a curly quote or an em dash in any user-entered text
   * would be rejected by the database, in development only, which is the worst
   * place for a difference from production to hide.
   *
   * `TEMPLATE template0` is required to override the encoding, because
   * template1 carries the cluster's own.
   */
  const client = new Client({
    connectionString: `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/postgres`,
  })

  await client.connect()
  try {
    await client.query(
      `CREATE DATABASE "${DATABASE}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
    )
    console.log(`Created database "${DATABASE}" with UTF-8 encoding.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!message.includes('already exists')) throw error

    const { rows } = await client.query<{ encoding: string }>(
      `SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1`,
      [DATABASE],
    )

    const encoding = rows[0]?.encoding ?? 'unknown'
    console.log(`Database "${DATABASE}" already exists (encoding: ${encoding}).`)

    if (encoding !== 'UTF8') {
      console.warn(
        [
          '',
          `  WARNING: "${DATABASE}" is ${encoding}, not UTF8.`,
          '  Text outside that encoding will be rejected on write.',
          '  Drop the database and run this again to recreate it.',
          '',
        ].join('\n'),
      )
    }
  } finally {
    await client.end()
  }

  const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`
  console.log(`\nPostgreSQL is running.\n\n  DATABASE_URL=${url}\n  DIRECT_DATABASE_URL=${url}\n`)
}

async function stop() {
  await createServer().stop()
  console.log('PostgreSQL stopped.')
}

async function main() {
  const command = process.argv[2]

  if (command === 'start') {
    await start()
  } else if (command === 'stop') {
    await stop()
  } else {
    console.error('Usage: tsx scripts/dev-db.ts <start|stop>')
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
