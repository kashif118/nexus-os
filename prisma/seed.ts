/**
 * Database seed.
 *
 * Reconciles the permission catalogue and system role templates from code into
 * the database. Safe to run repeatedly, and run on every deploy so that adding a
 * permission needs no migration.
 *
 *   npm run db:seed
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file)
  if (existsSync(path)) process.loadEnvFile(path)
}

async function main() {
  const { seedAuthorization } = await import('../src/kernel/authz/seed')
  const result = await seedAuthorization()
  console.log(
    `Seeded ${result.permissions} permissions, ${result.roles} system roles, ${result.grants} grants.`,
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    const { getSystemDb } = await import('../src/lib/db')
    await getSystemDb().$disconnect()
  })
