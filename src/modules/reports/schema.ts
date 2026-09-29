import { z } from 'zod'

export const SCHEDULES = ['daily', 'weekly', 'monthly'] as const
export type Schedule = (typeof SCHEDULES)[number]

export const reportSchema = z.object({
  template: z.string().min(1, 'Choose a report.').max(64),
  name: z.string().trim().min(1, 'Name this report.').max(120),
  period: z.enum(['7d', '30d', '90d', '12m', 'ytd']).optional(),
  schedule: z
    .union([z.enum(SCHEDULES), z.literal('')])
    .optional()
    .transform((value) => (value && value.length > 0 ? (value as Schedule) : null)),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })
