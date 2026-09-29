import { z } from 'zod'

const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.literal('')])
  .optional()
  .transform((value) => value === 'on' || value === 'true')

export const idSchema = z.object({ id: z.string().min(1).max(64) })

export const apiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name this key.').max(80),
  /** Comma-separated permission keys from the form's checkbox group. */
  scopes: z
    .string()
    .min(1, 'Choose what this key may do.')
    .transform((value) =>
      value
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  expiresInDays: z
    .string()
    .optional()
    .transform((value) => {
      if (!value || value.trim().length === 0) return undefined
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed > 0 && parsed <= 3650 ? parsed : undefined
    }),
})

export const policySchema = z.object({
  sessionIdleMinutes: z.coerce.number().int().min(15).max(525_600),
  allowedIpRanges: z
    .string()
    .max(2_000)
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(/[\n,]/)
        .map((range) => range.trim())
        .filter(Boolean),
    ),
  alertOnNewIp: checkbox,
})
