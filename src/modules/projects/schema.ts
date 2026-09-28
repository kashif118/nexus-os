import { z } from 'zod'

import { minorUnitExponent, parseAmount } from '@/lib/money'

export const PROJECT_STATUSES = [
  'PLANNING',
  'ACTIVE',
  'AT_RISK',
  'ON_HOLD',
  'COMPLETED',
  'ARCHIVED',
] as const

export const PROJECT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export const PROJECT_VISIBILITIES = ['ORGANIZATION', 'TEAM', 'PRIVATE'] as const
export const PROJECT_ROLES = ['LEAD', 'CONTRIBUTOR', 'VIEWER'] as const
export const MILESTONE_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'MISSED'] as const
export const HEALTH_STATUSES = ['HEALTHY', 'AT_RISK', 'CRITICAL'] as const

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))

const optionalId = z
  .string()
  .trim()
  .max(64)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined))

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? new Date(value) : undefined))
  .refine((value) => value === undefined || !Number.isNaN(value.getTime()), 'Enter a valid date.')

/**
 * The project key.
 *
 * Short and upper-case because it prefixes task numbers (NEX-142) and is what
 * people type when searching.
 */
export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Use at least 2 characters.')
  .max(10, 'Use at most 10 characters.')
  .regex(/^[A-Z][A-Z0-9]*$/, 'Use letters and numbers, starting with a letter.')

const optionalMoney = (currency: string) =>
  z
    .string()
    .trim()
    .max(32)
    .optional()
    .refine(
      (value) => !value || value.length === 0 || parseAmount(value, currency) !== null,
      `Enter an amount with at most ${minorUnitExponent(currency)} decimal places.`,
    )
    .transform((value) =>
      value && value.length > 0 ? (parseAmount(value, currency) ?? undefined) : undefined,
    )

export const projectInputSchema = (currency: string) =>
  z.object({
    key: projectKeySchema,
    name: z.string().trim().min(1, 'Enter a project name.').max(160),
    description: optionalText(4000),
    companyId: optionalId,
    managerMembershipId: optionalId,
    status: z.enum(PROJECT_STATUSES).default('PLANNING'),
    priority: z.enum(PROJECT_PRIORITIES).default('MEDIUM'),
    visibility: z.enum(PROJECT_VISIBILITIES).default('ORGANIZATION'),
    startDate: optionalDate,
    dueDate: optionalDate,
    budgetMinor: optionalMoney(currency),
  })

export const projectMemberSchema = z.object({
  projectId: z.string().min(1).max(64),
  membershipId: z.string().min(1).max(64),
  role: z.enum(PROJECT_ROLES).default('CONTRIBUTOR'),
  allocationPercent: z.coerce.number().int().min(0).max(100).default(0),
})

export const removeMemberSchema = z.object({
  projectId: z.string().min(1).max(64),
  membershipId: z.string().min(1).max(64),
})

export const milestoneInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'Enter a milestone name.').max(160),
  description: optionalText(1000),
  dueDate: optionalDate,
})

export const milestoneStatusSchema = z.object({
  milestoneId: z.string().min(1).max(64),
  status: z.enum(MILESTONE_STATUSES),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })

/** Columns the server will order a project list by. Allowlisted. */
export const PROJECT_SORT_FIELDS = [
  'name',
  'status',
  'priority',
  'dueDate',
  'healthScore',
  'createdAt',
] as const

export type ProjectSort = (typeof PROJECT_SORT_FIELDS)[number]
