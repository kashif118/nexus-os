import { createHash, createHmac } from 'node:crypto'

import { assertSafeKey, type StorageDriver, type StoredObject } from './types'

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
 *
 * Signed with SigV4 using `node:crypto` and plain `fetch`, so the application
 * carries no vendor SDK. Credentials are read once from validated configuration
 * and never leave this module: they are not logged, not returned in errors, and
 * never sent to the browser.
 *
 * Note on presigned URLs: the architecture (docs/OPERATIONS.md §N) allows
 * short-TTL presigned downloads, but this driver deliberately does not issue
 * them. A presigned URL is a bearer token for a file — once issued it works for
 * anyone who has it, for as long as it lives, with no further authorization
 * check. Streaming through the route handler costs one extra hop and keeps
 * every byte behind a permission check. If throughput ever makes that a
 * problem, presigning is a change to this driver alone.
 *
 * This driver is exercised by unit tests over its signing logic. It has not
 * been run against a live bucket in this environment, because no credentials
 * were supplied and inventing them was not an option.
 */
export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Path-style addressing suits MinIO and R2; virtual-host style suits AWS. */
  forcePathStyle?: boolean
}

const SERVICE = 's3'

export function createS3Driver(config: S3Config): StorageDriver {
  const endpoint = config.endpoint.replace(/\/+$/, '')

  const urlFor = (key: string): URL => {
    assertSafeKey(key)
    const base = new URL(endpoint)
    if (config.forcePathStyle ?? true) {
      base.pathname = `/${config.bucket}/${key}`
    } else {
      base.host = `${config.bucket}.${base.host}`
      base.pathname = `/${key}`
    }
    return base
  }

  const send = async (
    method: 'PUT' | 'GET' | 'DELETE' | 'HEAD',
    key: string,
    body?: Uint8Array,
    contentType?: string,
  ): Promise<Response> => {
    const url = urlFor(key)
    const payloadHash = body ? sha256Hex(body) : sha256Hex(new Uint8Array())

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(new Date()),
    }
    if (contentType) headers['content-type'] = contentType

    headers.authorization = signRequest({ method, url, headers, payloadHash, config })

    return fetch(url, {
      method,
      headers,
      ...(body ? { body: body as BodyInit } : {}),
    })
  }

  return {
    name: 's3',

    async put(key, body, contentType) {
      const response = await send('PUT', key, body, contentType)
      if (!response.ok) throw new Error(`Storage upload failed (${response.status}).`)
    },

    async get(key): Promise<StoredObject | null> {
      const response = await send('GET', key)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Storage read failed (${response.status}).`)

      const buffer = new Uint8Array(await response.arrayBuffer())
      return {
        body: buffer,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        sizeBytes: buffer.byteLength,
      }
    },

    async delete(key) {
      const response = await send('DELETE', key)
      if (!response.ok && response.status !== 404) {
        throw new Error(`Storage delete failed (${response.status}).`)
      }
    },

    async exists(key) {
      const response = await send('HEAD', key)
      return response.ok
    },
  }
}

/* -------------------------------------------------------------------------- */
/* SigV4                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the `Authorization` header for one request.
 *
 * Exported for unit testing: signing is the part of this driver that can be
 * verified without a bucket, and it is where a mistake is silent — a wrong
 * signature looks like a permissions problem rather than a bug.
 */
export function signRequest({
  method,
  url,
  headers,
  payloadHash,
  config,
  now,
}: {
  method: string
  url: URL
  headers: Record<string, string>
  payloadHash: string
  config: S3Config
  now?: Date
}): string {
  const amz = headers['x-amz-date'] ?? amzDate(now ?? new Date())
  const date = amz.slice(0, 8)
  const scope = `${date}/${config.region}/${SERVICE}/aws4_request`

  const sortedKeys = Object.keys(headers)
    .map((key) => key.toLowerCase())
    .sort()

  const canonicalHeaders = sortedKeys
    .map((key) => `${key}:${String(headers[key] ?? headers[key.toLowerCase()] ?? '').trim()}\n`)
    .join('')
  const signedHeaders = sortedKeys.join(';')

  const canonicalRequest = [
    method,
    encodePath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amz,
    scope,
    sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join('\n')

  let signingKey: Buffer = Buffer.from(`AWS4${config.secretAccessKey}`)
  for (const part of [date, config.region, SERVICE, 'aws4_request']) {
    signingKey = hmac(signingKey, part)
  }

  const signature = hmac(signingKey, stringToSign).toString('hex')

  return (
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  )
}

export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** Each path segment is URI-encoded, but the separators are not. */
export function encodePath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/')
}

export function canonicalQuery(params: URLSearchParams): string {
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join('&')
}

/** `encodeURIComponent` leaves characters AWS expects to be escaped. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}
