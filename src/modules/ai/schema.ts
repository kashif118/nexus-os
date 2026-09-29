import { z } from 'zod'

export const askSchema = z.object({
  conversationId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  question: z.string().trim().min(1, 'Ask a question.').max(8_000),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })
