/**
 * The storage contract.
 *
 * Everything above this interface deals in opaque keys. Nothing above it knows
 * whether bytes live on a disk or in a bucket, and — more importantly — nothing
 * above it can hand out a URL that bypasses an authorization check, because the
 * interface does not offer one. Reads go through `get`, which returns bytes to
 * a route handler that has already decided the caller may have them.
 */
export interface StoredObject {
  body: Uint8Array
  contentType: string
  sizeBytes: number
}

export interface StorageDriver {
  /** Human-readable driver name, surfaced in health checks and logs. */
  readonly name: string

  put(key: string, body: Uint8Array, contentType: string): Promise<void>

  /** Returns null when the object is absent rather than throwing. */
  get(key: string): Promise<StoredObject | null>

  delete(key: string): Promise<void>

  exists(key: string): Promise<boolean>
}

/**
 * Storage keys are generated, never supplied by a client.
 *
 * The shape is `org/{orgId}/{yyyy}/{uuid}{ext}`: the organization prefix means
 * an object's tenant is visible in the store itself, which makes a bulk export
 * or a lifecycle rule per tenant possible later.
 */
export function buildStorageKey(orgId: string, extension: string): string {
  const year = new Date().getUTCFullYear()
  const uuid = crypto.randomUUID()
  const suffix = normaliseExtension(extension)
  return `org/${orgId}/${year}/${uuid}${suffix}`
}

/** A conservative extension: lowercase alphanumerics, at most 10 characters. */
export function normaliseExtension(extension: string): string {
  const cleaned = extension
    .replace(/^\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return cleaned.length > 0 && cleaned.length <= 10 ? `.${cleaned}` : ''
}

/**
 * Reject anything that is not a key this application generated.
 *
 * A traversal (`../`), an absolute path or a backslash must never reach a
 * driver: with the local driver that would read outside the storage root, and
 * with S3 it would address an unintended object.
 */
export function assertSafeKey(key: string): void {
  const valid = /^org\/[A-Za-z0-9_-]+\/\d{4}\/[A-Za-z0-9._-]+$/.test(key)
  if (!valid || key.includes('..')) {
    throw new Error('Refusing to use an unrecognised storage key.')
  }
}
