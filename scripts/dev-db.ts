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

  try {
    await server.createDatabase(DATABASE)
    console.log(`Created database "${DATABASE}".`)
  } catch {
    console.log(`Database "${DATABASE}" already exists.`)
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
