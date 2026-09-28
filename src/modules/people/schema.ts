import { z } from 'zod'

import { minorUnitExponent, parseAmount } from '@/lib/money'

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN'] as const
export const TEAM_ROLES = ['LEAD', 'MEMBER'] as const

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

export const profileSchema = (currency: string) =>
  z.object({
    membershipId: z.string().min(1).max(64),
    position: optionalText(120),
    employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
    departmentId: optionalId,
    hireDate: optionalDate,
    location: optionalText(120),
    weeklyCapacityMinutes: z.coerce.number().int().min(0).max(10_080).default(2400),
    costRateMinor: optionalMoney(currency),
    billRateMinor: optionalMoney(currency),
    managerMembershipId: optionalId,
  })

export const teamSchema = z.object({
  name: z.string().trim().min(1, 'Enter a team name.').max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Use at least 2 characters.')
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens.'),
  description: optionalText(400),
  departmentId: optionalId,
  leadMembershipId: optionalId,
})

export const teamMemberSchema = z.object({
  teamId: z.string().min(1).max(64),
  membershipId: z.string().min(1).max(64),
  role: z.enum(TEAM_ROLES).default('MEMBER'),
})

export const removeTeamMemberSchema = z.object({
  teamId: z.string().min(1).max(64),
  membershipId: z.string().min(1).max(64),
})

export const departmentSchema = z.object({
  name: z.string().trim().min(1, 'Enter a department name.').max(80),
  description: optionalText(400),
  parentId: optionalId,
  headMembershipId: optionalId,
})

export const skillSchema = z.object({
  name: z.string().trim().min(1, 'Enter a skill name.').max(60),
  category: optionalText(60),
})

export const memberSkillSchema = z.object({
  membershipId: z.string().min(1).max(64),
  skillId: z.string().min(1).max(64),
  level: z.coerce.number().int().min(1).max(5).default(3),
})
