import { z } from 'zod'

const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.literal('')])
  .optional()
  .transform((value) => value === 'on' || value === 'true')

export const configureAgentSchema = z.object({
  agentKey: z.string().min(1).max(64),
  enabled: checkbox,
  autonomy: z.enum(['SUGGEST', 'AUTONOMOUS']).default('SUGGEST'),
  ownerMembershipId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  extraInstructions: z
    .string()
    .trim()
    .max(2_000)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
})

export const runAgentSchema = z.object({
  agentKey: z.string().min(1).max(64),
  question: z
    .string()
    .trim()
    .max(2_000)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
})

export const proposalSchema = z.object({ id: z.string().min(1).max(64) })
