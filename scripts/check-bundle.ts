/**
 * The client bundle budget.
 *
 * Run after `next build`. It measures what a browser actually downloads and
 * fails if it has grown past a budget, because bundle size is the classic
 * regression nobody notices: every individual import looks small.
 *
 * Two numbers are checked:
 *
 * 1. **The shared bundle** — the chunks every route loads, gzipped. This is the
 *    cost of opening the product at all, so it gets the tighter budget.
 * 2. **Total client JavaScript** — every chunk, gzipped. Routes load their own
 *    chunks lazily, so this is not what any one page pays, but it does catch a
 *    heavy dependency that landed in one screen.
 *
 * Gzip rather than raw bytes, because gzip is what crosses the network. The
 * budgets are set a little above where the build currently sits: a budget the
 * build is already failing is noise, and one with enormous headroom never
 * fires.
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const SHARED_BUDGET_KB = 160
const TOTAL_BUDGET_KB = 900

const BUILD_DIR = '.next'

interface BuildManifest {
  rootMainFiles?: string[]
}

function gzippedKb(paths: string[]): number {
  let bytes = 0
  for (const path of paths) bytes += gzipSync(readFileSync(path), { level: 9 }).length
  return bytes / 1024
}

async function main(): Promise<void> {
  let manifest: BuildManifest
  try {
    manifest = JSON.parse(readFileSync(join(BUILD_DIR, 'build-manifest.json'), 'utf8'))
  } catch {
    console.error('No build found. Run `npm run build` first.')
    process.exit(1)
  }

  const shared = (manifest.rootMainFiles ?? []).map((file) => join(BUILD_DIR, file))
  if (shared.length === 0) {
    console.error('The build manifest lists no shared chunks, which should not happen.')
    process.exit(1)
  }

  const chunkDir = join(BUILD_DIR, 'static', 'chunks')
  const entries = await readdir(chunkDir, { recursive: true, withFileTypes: true })
  const allChunks = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => join(entry.parentPath, entry.name))

  const sharedKb = gzippedKb(shared)
  const totalKb = gzippedKb(allChunks)

  const rows = [
    { label: 'Shared by every route', value: sharedKb, budget: SHARED_BUDGET_KB },
    { label: 'All client JavaScript', value: totalKb, budget: TOTAL_BUDGET_KB },
  ]

  console.log('Client bundle (gzipped)\n')
  for (const row of rows) {
    const status = row.value <= row.budget ? 'ok  ' : 'OVER'
    console.log(
      `  ${status}  ${row.label.padEnd(24)} ${row.value.toFixed(1).padStart(7)} KB  ` +
        `of ${row.budget} KB budget`,
    )
  }
  console.log(`\n  ${allChunks.length} chunks in total.`)

  const over = rows.filter((row) => row.value > row.budget)
  if (over.length > 0) {
    console.error(
      `\nOver budget: ${over.map((row) => row.label).join(', ')}. ` +
        'Either the growth is justified and the budget moves in the same commit, or it is not.',
    )
    process.exit(1)
  }
}

void main()
