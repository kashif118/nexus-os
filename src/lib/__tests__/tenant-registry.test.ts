import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { TENANT_MODELS } from '../db'

/**
 * Guards the completeness of the tenant-model registry.
 *
 * The org-scoping Prisma client can only protect models it knows about, so a
 * model added in a later phase with a required `organizationId` MUST appear in
 * `TENANT_MODELS`. Prisma 7 trims field nullability out of the runtime DMMF, so
 * the schema files themselves are the source of truth and are parsed here.
 *
 * This test needs no database, so it runs on every commit. If it fails, a new
 * model is unscoped — which is a tenant-isolation hole, not a style issue.
 */

const SCHEMA_DIR = resolve(process.cwd(), 'prisma/schema')

interface ParsedModel {
  name: string
  hasRequiredOrgId: boolean
  hasNullableOrgId: boolean
}

function parseModels(): ParsedModel[] {
  const models: ParsedModel[] = []

  for (const file of readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.prisma'))) {
    const source = readFileSync(resolve(SCHEMA_DIR, file), 'utf8')

    // Match `model Name { ... }` blocks. Models cannot nest, so a non-greedy
    // match up to the first line-start closing brace is exact.
    const blocks = source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)

    for (const [, name, body] of blocks) {
      if (!name || !body) continue

      // Strip comments so a documented field name is not mistaken for a real one.
      const code = body
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').trim())
        .filter(Boolean)

      const field = code.find((line) => /^organizationId\s+String/.test(line))

      models.push({
        name,
        hasRequiredOrgId: Boolean(field) && !/^organizationId\s+String\?/.test(field ?? ''),
        hasNullableOrgId: /^organizationId\s+String\?/.test(field ?? ''),
      })
    }
  }

  return models
}

describe('tenant model registry', () => {
  const models = parseModels()

  it('finds the schema', () => {
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((model) => model.name)).toContain('Membership')
  })

  it('registers every model with a required organizationId', () => {
    const required = models
      .filter((model) => model.hasRequiredOrgId)
      .map((model) => model.name)
      .sort()

    const missing = required.filter((name) => !TENANT_MODELS.has(name))

    expect(
      missing,
      `These models declare a required organizationId but are missing from TENANT_MODELS in ` +
        `src/lib/db.ts, so the org-scoped client will NOT filter them:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('does not register models that have no organizationId', () => {
    const scopable = new Set(
      models.filter((model) => model.hasRequiredOrgId).map((model) => model.name),
    )

    const spurious = [...TENANT_MODELS].filter((name) => !scopable.has(name))

    expect(
      spurious,
      `These are registered as tenant models but have no required organizationId column, so ` +
        `every query against them would be filtered on a field that does not exist:\n  ${spurious.join('\n  ')}`,
    ).toEqual([])
  })

  it('excludes models whose organizationId is nullable', () => {
    for (const model of models.filter((entry) => entry.hasNullableOrgId)) {
      expect(
        TENANT_MODELS.has(model.name),
        `${model.name}.organizationId is nullable, so it cannot be auto-scoped; scope it explicitly.`,
      ).toBe(false)
    }
  })
})
