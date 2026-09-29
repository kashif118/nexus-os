import { getSystemDb, type Prisma } from '@/lib/db'
import { log } from '@/kernel/observability/logger'

/**
 * Append-only audit writer (docs/OPERATIONS.md §N.1).
 *
 * Distinct from `LoginEvent`, which records authentication attempts. This is the
 * compliance record of *what changed*.
 *
 * Once the event backbone exists, business writes call this inside the same
 * transaction as the change. Authentication events are written outside a
 * transaction on purpose: the audit row must survive even when the operation it
 * describes failed (a rejected sign-in, a reset for an unknown address).
 */

/**
 * An audited action, written as `module.thing_that_happened`.
 *
 * A pattern rather than a central union on purpose: a union would mean every
 * module editing one shared file to add its own actions, which turns an
 * append-only log into a merge-conflict magnet. The dot is still enforced, so
 * the module prefix is always present and the log stays groupable.
 *
 * Examples: `auth.signed_in`, `crm.deal.stage_changed`,
 * `finance.invoice.approved`.
 */
export type AuditAction = `${string}.${string}`

export interface AuditInput {
  action: AuditAction
  entityType: string
  entityId?: string | null
  actorId?: string | null
  actorType?: 'USER' | 'SYSTEM' | 'AGENT' | 'WORKFLOW' | 'API_KEY'
  organizationId?: string | null
  metadata?: Prisma.InputJsonValue
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

/**
 * Write one audit record.
 *
 * Never throws: an audit failure must not turn a successful sign-in into a 500.
 * The write is best-effort and any failure is logged for follow-up.
 */
export async function writeAuditLog(input: AuditInput): Promise<void> {
  try {
    await getSystemDb().auditLog.create({
      data: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? 'USER',
        organizationId: input.organizationId ?? null,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
      },
    })
  } catch (error) {
    log.error('audit.write.failed', { action: input.action, error })
  }
}
