import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { assertSafeKey, type StorageDriver, type StoredObject } from './types'

/**
 * Filesystem storage for development.
 *
 * Deliberately NOT inside `public/`. Next serves everything under `public/`
 * without asking anyone's permission, so a document written there would be
 * downloadable by anyone who guessed the filename — exactly the failure this
 * module is built to prevent. The root defaults to `.storage/`, which is
 * gitignored, and every path is re-checked against that root after resolution
 * so a crafted key cannot escape it.
 *
 * This driver does not work on a serverless host with an ephemeral filesystem.
 * Production uses the S3 driver; `docs/OPERATIONS.md` records which variables
 * that needs.
 */
export function createLocalDriver(root: string): StorageDriver {
  const base = resolve(root)

  const pathFor = (key: string): string => {
    assertSafeKey(key)
    const full = resolve(join(base, key))
    // Belt and braces: even with a validated key, never write outside the root.
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error('Refusing to access a path outside the storage root.')
    }
    return full
  }

  return {
    name: 'local',

    async put(key, body, contentType) {
      const path = pathFor(key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
      // The content type is not stored on disk; it lives on the Document row,
      // which is the record of truth for how the file is served.
      void contentType
    },

    async get(key): Promise<StoredObject | null> {
      const path = pathFor(key)
      try {
        const body = await readFile(path)
        return {
          body: new Uint8Array(body),
          // The caller supplies the type from the database; the driver does not
          // guess one from the extension.
          contentType: 'application/octet-stream',
          sizeBytes: body.byteLength,
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async delete(key) {
      const path = pathFor(key)
      await rm(path, { force: true })
    },

    async exists(key) {
      try {
        await stat(pathFor(key))
        return true
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    },
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** SHA-256 of the bytes, stored so corruption and duplicates are detectable. */
export function checksumOf(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}
