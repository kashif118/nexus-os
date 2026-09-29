import { z } from 'zod'

export const markReadSchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((value) => value.split(',').filter((id) => id.length > 0 && id.length <= 64))
    .pipe(z.array(z.string()).min(1).max(200)),
})

const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.literal('')])
  .optional()
  .transform((value) => value === 'on' || value === 'true')

export const preferenceSchema = z.object({
  eventType: z.string().min(1).max(80),
  inApp: checkbox,
  email: checkbox,
  digest: checkbox,
})
