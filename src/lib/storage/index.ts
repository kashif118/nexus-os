import { getStorageConfig } from '@/kernel/config/env'

import { createLocalDriver } from './local'
import { createS3Driver } from './s3'
import type { StorageDriver } from './types'

export { checksumOf } from './local'
export {
  ALLOWED_TYPES,
  MAX_UPLOAD_BYTES,
  extensionOf,
  inspectUpload,
  safeFileName,
  type ContentDecision,
} from './content'
export { assertSafeKey, buildStorageKey, type StorageDriver, type StoredObject } from './types'

/**
 * The single place a storage driver is constructed.
 *
 * Which driver runs is configuration, not a code path chosen at a call site —
 * every caller gets the same interface, so nothing above here can accidentally
 * depend on the filesystem.
 */
let cached: StorageDriver | undefined

export function getStorage(): StorageDriver {
  if (cached) return cached

  const config = getStorageConfig()

  cached =
    config.driver === 's3'
      ? createS3Driver({
          endpoint: config.s3.endpoint,
          region: config.s3.region,
          bucket: config.s3.bucket,
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
          forcePathStyle: config.s3.forcePathStyle,
        })
      : createLocalDriver(config.localDir)

  return cached
}

/** Test seam: forget the cached driver so configuration can change. */
export function resetStorage(): void {
  cached = undefined
}
