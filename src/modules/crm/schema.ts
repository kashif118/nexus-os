import { z } from 'zod'

import { minorUnitExponent, parseAmount } from '@/lib/money'

/**
 * CRM validation.
 *
 * One schema per command, shared by the form and the action. Money arrives as a
 * user-typed string and is converted to minor units here, so a float never
 * exists anywhere in the path (docs/DATA-MODEL.md §E.0).
 */

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'] as const
export const LEAD_SOURCES = [
  'WEBSITE',
  'REFERRAL',
  'OUTBOUND',
  'EVENT',
  'PARTNER',
  'OTHER',
] as const
export const DEAL_STATUSES = ['OPEN', 'WON', 'LOST'] as const
export const STAGE_TYPES = ['OPEN', 'WON', 'LOST'] as const
export const ACTIVITY_TYPES = ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'TASK'] as const

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined))
  .refine(
    (value) => value === undefined || z.email().safeParse(value).success,
    'Enter a valid email address.',
  )

/** Optional relation id from a form: an empty select means "none", not an error. */
const optionalId = z
  .string()
  .trim()
  .max(64)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined))

/* -------------------------------- companies ------------------------------- */

export const companyInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a company name.').max(160),
  domain: optionalText(120),
  industry: optionalText(80),
  size: optionalText(40),
  website: optionalText(200),
  phone: optionalText(40),
  notes: optionalText(2000),
  ownerMembershipId: optionalId,
})

/* -------------------------------- contacts -------------------------------- */

export const contactInputSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter a first name.').max(80),
  lastName: z.string().trim().min(1, 'Enter a last name.').max(80),
  email: optionalEmail,
  phone: optionalText(40),
  position: optionalText(120),
  notes: optionalText(2000),
  companyId: optionalId,
  ownerMembershipId: optionalId,
})

/* ---------------------------------- leads --------------------------------- */

export const leadInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(160),
  email: optionalEmail,
  phone: optionalText(40),
  companyName: optionalText(160),
  source: z.enum(LEAD_SOURCES).default('OTHER'),
  status: z.enum(LEAD_STATUSES).default('NEW'),
  score: z.coerce.number().int().min(0).max(100).default(0),
  notes: optionalText(2000),
  ownerMembershipId: optionalId,
})

export const convertLeadSchema = z.object({
  leadId: z.string().min(1).max(64),
  /** Create a deal as part of the conversion. */
  createDeal: z
    .union([z.literal('on'), z.literal('true'), z.literal('')])
    .optional()
    .transform((value) => value === 'on' || value === 'true'),
  dealTitle: optionalText(200),
  dealValue: optionalText(32),
})

/* ---------------------------------- deals --------------------------------- */

/**
 * A money field.
 *
 * Validated against the organization currency so "1.999" is rejected for USD
 * rather than silently truncated. Returns minor units.
 */
export const moneyField = (currency: string) =>
  z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : '0'))
    .refine((value) => parseAmount(value, currency) !== null, {
      error: `Enter an amount with at most ${minorUnitExponent(currency)} decimal places.`,
    })
    .transform((value) => parseAmount(value, currency)!)

export const dealInputSchema = (currency: string) =>
  z.object({
    title: z.string().trim().min(1, 'Enter a deal title.').max(200),
    pipelineId: z.string().min(1, 'Choose a pipeline.').max(64),
    stageId: z.string().min(1, 'Choose a stage.').max(64),
    companyId: optionalId,
    primaryContactId: optionalId,
    valueMinor: moneyField(currency),
    expectedCloseDate: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value && value.length > 0 ? new Date(value) : undefined))
      .refine(
        (value) => value === undefined || !Number.isNaN(value.getTime()),
        'Enter a valid date.',
      ),
    ownerMembershipId: optionalId,
  })

export const moveDealSchema = z.object({
  dealId: z.string().min(1).max(64),
  stageId: z.string().min(1).max(64),
})

export const closeDealSchema = z.object({
  dealId: z.string().min(1).max(64),
  outcome: z.enum(['WON', 'LOST']),
  lostReason: optionalText(300),
})

/* -------------------------------- activities ------------------------------ */

export const activityInputSchema = z.object({
  type: z.enum(ACTIVITY_TYPES).default('NOTE'),
  subject: z.string().trim().min(1, 'Enter a subject.').max(200),
  body: optionalText(4000),
  dueAt: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? new Date(value) : undefined))
    .refine(
      (value) => value === undefined || !Number.isNaN(value.getTime()),
      'Enter a valid date.',
    ),
  entityType: z.enum(['Company', 'Contact', 'Lead', 'Deal']),
  entityId: z.string().min(1).max(64),
})

/* ----------------------------------- tags --------------------------------- */

export const tagInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a tag name.').max(40),
  color: z.enum(['neutral', 'info', 'success', 'warning', 'destructive']).default('neutral'),
})

export const entityTagSchema = z.object({
  tagId: z.string().min(1).max(64),
  entityType: z.enum(['Company', 'Contact', 'Lead', 'Deal']),
  entityId: z.string().min(1).max(64),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })

export type CompanyInput = z.infer<typeof companyInputSchema>
export type ContactInput = z.infer<typeof contactInputSchema>
export type LeadInput = z.infer<typeof leadInputSchema>
export type ActivityInput = z.infer<typeof activityInputSchema>

/* --------------------------------- sorting -------------------------------- */

export const COMPANY_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const
export const CONTACT_SORT_FIELDS = ['lastName', 'createdAt', 'updatedAt'] as const
export const LEAD_SORT_FIELDS = ['name', 'score', 'status', 'createdAt'] as const
export const DEAL_SORT_FIELDS = ['title', 'valueMinor', 'expectedCloseDate', 'createdAt'] as const
