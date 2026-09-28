import { z } from 'zod'

import { emailSchema } from '@/modules/auth/schema'

/**
 * Organization validation (docs/OPERATIONS.md §M.2).
 *
 * The slug is the tenant's URL identity, so it is normalised and constrained
 * here rather than trusted from input.
 */

/** Words that would collide with application routes or look official. */
const RESERVED_SLUGS = new Set([
  'api',
  'app',
  'admin',
  'account',
  'sign-in',
  'sign-up',
  'signin',
  'signup',
  'verify-email',
  'reset-password',
  'forgot-password',
  'new',
  'create',
  'organizations',
  'settings',
  'nexus',
  'support',
  'help',
  'docs',
  'status',
  'billing',
  'static',
  '_next',
  'public',
  'www',
])

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters.')
  .max(48, 'Use at most 48 characters.')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens between them.',
  )
  .refine((value) => !RESERVED_SLUGS.has(value), 'That address is reserved.')

export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter an organization name.')
  .max(120, 'That name is too long.')

/** ISO-4217, as stored on the organization and every money column. */
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, 'Use a three-letter currency code.')
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code.')

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'That is not a recognised time zone.')

export const createOrganizationSchema = z.object({
  name: organizationNameSchema,
  slug: slugSchema,
  industry: z.string().trim().max(80).optional().or(z.literal('')),
  timezone: timezoneSchema.default('UTC'),
  currency: currencySchema.default('USD'),
  country: z.string().trim().max(60).optional().or(z.literal('')),
})

export const updateOrganizationSchema = z.object({
  name: organizationNameSchema,
  description: z.string().trim().max(500).optional().or(z.literal('')),
  industry: z.string().trim().max(80).optional().or(z.literal('')),
  timezone: timezoneSchema,
  currency: currencySchema,
  country: z.string().trim().max(60).optional().or(z.literal('')),
})

export const inviteMemberSchema = z.object({
  email: emailSchema,
  title: z.string().trim().max(120).optional().or(z.literal('')),
})

export const membershipIdSchema = z.object({ membershipId: z.string().min(1).max(64) })

export const acceptInvitationSchema = z.object({ token: z.string().min(1).max(256) })

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>

/** Derive a candidate slug from a name, for the create form's convenience. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}
