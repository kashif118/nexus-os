import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { getDatabaseUrl, isProduction } from '@/kernel/config/env'

/**
 * Database access and tenant isolation (docs/PLATFORM.md §H.3, layer 4).
 *
 * Two clients exist, and the difference between them is the most important
 * security boundary in the system:
 *
 * - `getDb(orgId)` — org-scoped. A Prisma client extension rewrites every query
 *   against a tenant model to include `organizationId`, and rejects any attempt
 *   to name a different organization. Forgetting a `where` clause is therefore
 *   not a data leak; it is a query that returns this organization's rows.
 * - `getSystemDb()` — unscoped. Reserved for the cross-tenant surfaces listed in
 *   §H.4 (authentication, organization creation, invitation acceptance, billing
 *   webhooks, cron). Its use is deliberately conspicuous.
 *
 * Prisma 7 no longer reads the connection string from the schema — it requires a
 * driver adapter supplied at construction (docs/ROADMAP.md §U2).
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
  orgClients?: Map<string, OrgScopedClient>
}

function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: getDatabaseUrl() }),
    log: isProduction ? ['error'] : ['error', 'warn'],
  })
}

/**
 * The unscoped client, cached on `globalThis` so hot reloads in development and
 * warm serverless instances reuse one connection pool.
 */
export function getSystemDb(): PrismaClient {
  globalForPrisma.prisma ??= createClient()
  return globalForPrisma.prisma
}

/* -------------------------------------------------------------------------- */
/* Tenant model registry                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every model carrying a non-nullable `organizationId`.
 *
 * This list is explicit rather than derived: Prisma 7 trims the runtime DMMF so
 * that field nullability is no longer exposed, and inferring "required" from it
 * is impossible (docs/ROADMAP.md §U16).
 *
 * Completeness is therefore enforced by a test instead of by the runtime:
 * `src/lib/__tests__/tenant-registry.test.ts` parses `prisma/schema/*.prisma`
 * and fails if any model declares a required `organizationId` and is missing
 * here. Adding a tenant model without scoping it breaks CI.
 *
 * `AuditLog` is deliberately absent — its `organizationId` is nullable by
 * design, because account-level events such as sign-up belong to no
 * organization. It is scoped explicitly at its call sites instead.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set<string>(['Membership', 'Invitation'])

/** Prisma delegate property name (`membership`) for a model name (`Membership`). */
const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1)

/* -------------------------------------------------------------------------- */
/* Org-scoped client                                                           */
/* -------------------------------------------------------------------------- */

/** Operations whose `where` must be constrained to the organization. */
const WHERE_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
])

/** Operations addressing a single row by unique selector. */
const UNIQUE_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow'])

/** Operations that both select a row and write to it. */
const SINGLE_WRITE_OPERATIONS = new Set(['update', 'delete', 'upsert'])

class CrossTenantAccessError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Cross-tenant access blocked: ${model}.${operation} named an organizationId other than the caller's. ` +
        'Never pass an organizationId from client input — the scoped client supplies it.',
    )
    this.name = 'CrossTenantAccessError'
  }
}

/**
 * Reject a caller-supplied `organizationId` that disagrees with the context.
 *
 * A matching value is allowed through (harmless, and it keeps explicit queries
 * readable); a different one is a bug or an attack, and is never silently
 * rewritten.
 */
function assertSameOrg(value: unknown, orgId: string, model: string, operation: string): void {
  if (value === undefined || value === null) return
  if (typeof value === 'string' && value === orgId) return
  throw new CrossTenantAccessError(model, operation)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

/**
 * Expand a compound unique selector into its component fields.
 *
 * Prisma addresses a compound unique as a single nested key —
 * `{ organizationId_userId: { organizationId, userId } }` — which hides the
 * organization from a top-level check and is not a valid `findFirst` filter.
 * Flattening it both exposes the value for validation and makes the rewritten
 * query legal.
 *
 * The shape is unambiguous: a compound key always contains an underscore and
 * maps to an object of scalars, whereas a relation filter (`user: { email }`)
 * has no underscore in its key.
 */
function flattenCompoundUnique(where: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(where)) {
    const isCompound =
      key.includes('_') &&
      isPlainObject(value) &&
      Object.values(value).every((v) => !isPlainObject(v))

    if (isCompound) Object.assign(result, value)
    else result[key] = value
  }

  return result
}

function scopeWhere(
  where: Record<string, unknown> | undefined,
  orgId: string,
  model: string,
  operation: string,
  { flatten = false }: { flatten?: boolean } = {},
): Record<string, unknown> {
  const base = flatten ? flattenCompoundUnique(where ?? {}) : (where ?? {})
  assertSameOrg(base.organizationId, orgId, model, operation)
  return { ...base, organizationId: orgId }
}

function scopeData(
  data: Record<string, unknown>,
  orgId: string,
  model: string,
  operation: string,
): Record<string, unknown> {
  assertSameOrg(data.organizationId, orgId, model, operation)
  return { ...data, organizationId: orgId }
}

/**
 * Build a client bound to one organization.
 *
 * `findUnique` is rewritten to `findFirst`: Prisma rejects a non-unique field in
 * a `findUnique` selector, so scoping it any other way is impossible. The cost is
 * that a scoped `findUnique` loses its primary-key fast path; the benefit is that
 * `findUnique({ where: { id } })` with an id belonging to another tenant returns
 * null instead of that tenant's row.
 */
function createOrgScopedClient(orgId: string) {
  return getSystemDb().$extends({
    name: `org-scope:${orgId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args)

          const typedArgs = (args ?? {}) as Record<string, unknown>

          if (UNIQUE_OPERATIONS.has(operation)) {
            const rewritten = {
              ...typedArgs,
              where: scopeWhere(
                typedArgs.where as Record<string, unknown> | undefined,
                orgId,
                model,
                operation,
                { flatten: true },
              ),
            }
            const client = getSystemDb() as unknown as Record<
              string,
              {
                findFirst: (a: unknown) => Promise<unknown>
                findFirstOrThrow: (a: unknown) => Promise<unknown>
              }
            >
            const delegate = client[delegateName(model)]
            if (!delegate) return query(args)
            return operation === 'findUnique'
              ? delegate.findFirst(rewritten)
              : delegate.findFirstOrThrow(rewritten)
          }

          if (WHERE_OPERATIONS.has(operation) || SINGLE_WRITE_OPERATIONS.has(operation)) {
            // update/delete/upsert take a unique selector, which may be compound;
            // validate the nested organizationId without rewriting the shape,
            // since Prisma still requires the compound key here.
            const raw = (typedArgs.where ?? {}) as Record<string, unknown>
            assertSameOrg(flattenCompoundUnique(raw).organizationId, orgId, model, operation)
            typedArgs.where = WHERE_OPERATIONS.has(operation)
              ? { ...raw, organizationId: orgId }
              : raw
          }

          if (operation === 'create' || operation === 'upsert') {
            const key = operation === 'create' ? 'data' : 'create'
            const payload = typedArgs[key] as Record<string, unknown> | undefined
            if (payload) typedArgs[key] = scopeData(payload, orgId, model, operation)
          }

          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const data = typedArgs.data
            typedArgs.data = Array.isArray(data)
              ? data.map((row) =>
                  scopeData(row as Record<string, unknown>, orgId, model, operation),
                )
              : scopeData(data as Record<string, unknown>, orgId, model, operation)
          }

          return query(typedArgs)
        },
      },
    },
  })
}

export type OrgScopedClient = ReturnType<typeof createOrgScopedClient>

/**
 * The org-scoped client for a tenant.
 *
 * Repositories receive this and can no longer write an unscoped query by
 * accident. Instances are cached per organization for the life of the process,
 * since an extended client is a thin wrapper over the shared connection pool.
 */
export function getDb(orgId: string): OrgScopedClient {
  if (!orgId) throw new Error('getDb() requires an organization id.')
  globalForPrisma.orgClients ??= new Map()

  const cached = globalForPrisma.orgClients.get(orgId)
  if (cached) return cached

  const client = createOrgScopedClient(orgId)
  globalForPrisma.orgClients.set(orgId, client)
  return client
}

export { CrossTenantAccessError }

/**
 * Prisma-generated types are re-exported here so that `@prisma/client` has
 * exactly one import site in the codebase (enforced by `no-restricted-imports`).
 */
export type {
  Prisma,
  UserStatus,
  VerificationPurpose,
  ActorType,
  OrganizationStatus,
  MembershipStatus,
} from '@prisma/client'
