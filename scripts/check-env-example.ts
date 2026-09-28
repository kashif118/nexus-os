/**
 * CI guard: `.env.example` must document exactly the variables declared in the
 * Zod schemas (docs/OPERATIONS.md §P.4). Prevents the two drifting apart, which
 * is the usual reason a new developer cannot boot the app.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { clientEnvSchema, serverEnvSchema } from '../src/kernel/config/env'

const EXAMPLE_PATH = resolve(process.cwd(), '.env.example')

const declared = new Set([
  ...Object.keys(serverEnvSchema.shape),
  ...Object.keys(clientEnvSchema.shape),
])

const documented = new Set(
  readFileSync(EXAMPLE_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter((key): key is string => Boolean(key)),
)

const missing = [...declared].filter((key) => !documented.has(key)).sort()
const extra = [...documented].filter((key) => !declared.has(key)).sort()

if (missing.length > 0 || extra.length > 0) {
  if (missing.length > 0) {
    console.error(`Declared in env.ts but missing from .env.example:\n  ${missing.join('\n  ')}`)
  }
  if (extra.length > 0) {
    console.error(`Present in .env.example but not declared in env.ts:\n  ${extra.join('\n  ')}`)
  }
  process.exit(1)
}

console.log(`.env.example is in sync with env.ts (${declared.size} variables).`)
