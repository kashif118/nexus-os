import { describe, expect, it } from 'vitest'

import { clientEnvSchema, serverEnvSchema } from '../env'

describe('serverEnvSchema', () => {
  it('defaults NODE_ENV to development', () => {
    const parsed = serverEnvSchema.parse({})
    expect(parsed.NODE_ENV).toBe('development')
  })

  it('rejects an unknown NODE_ENV', () => {
    expect(serverEnvSchema.safeParse({ NODE_ENV: 'staging' }).success).toBe(false)
  })

  it('rejects a DATABASE_URL that is not a URL', () => {
    const result = serverEnvSchema.safeParse({ DATABASE_URL: 'not-a-url' })
    expect(result.success).toBe(false)
  })

  it('accepts a postgres connection string', () => {
    const url = 'postgresql://user:pass@localhost:5432/nexus'
    expect(serverEnvSchema.parse({ DATABASE_URL: url }).DATABASE_URL).toBe(url)
  })
})

describe('clientEnvSchema', () => {
  it('applies defaults when nothing is provided', () => {
    const parsed = clientEnvSchema.parse({})
    expect(parsed.NEXT_PUBLIC_APP_NAME).toBe('NEXUS OS')
    expect(parsed.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000')
  })

  it('rejects a malformed app URL', () => {
    expect(clientEnvSchema.safeParse({ NEXT_PUBLIC_APP_URL: 'localhost' }).success).toBe(false)
  })

  it('exposes only NEXT_PUBLIC_ prefixed keys', () => {
    for (const key of Object.keys(clientEnvSchema.shape)) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(true)
    }
  })
})
