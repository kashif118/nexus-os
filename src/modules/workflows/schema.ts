import { z } from 'zod'

export const WORKFLOW_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1, 'Name this workflow.').max(120),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  triggerType: z.string().min(1, 'Choose a trigger.').max(64),
})

/**
 * The graph arrives as JSON in one field.
 *
 * Parsed here only far enough to be an object; the real validation is
 * `validateGraph`, which knows about the registries and can explain what is
 * wrong in terms an author recognises.
 */
export const saveDraftSchema = z.object({
  id: z.string().min(1).max(64),
  graph: z
    .string()
    .min(2)
    .max(200_000)
    .transform((value, context) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        context.addIssue({ code: 'custom', message: 'That is not valid JSON.' })
        return z.NEVER
      }
    }),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })

export const statusSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(['ACTIVE', 'PAUSED']),
})

export const manualRunSchema = z.object({
  workflowId: z.string().min(1).max(64),
  payload: z
    .string()
    .max(20_000)
    .optional()
    .transform((value, context) => {
      if (!value || value.trim().length === 0) return {}
      try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          context.addIssue({ code: 'custom', message: 'The sample payload must be an object.' })
          return z.NEVER
        }
        return parsed as Record<string, unknown>
      } catch {
        context.addIssue({ code: 'custom', message: 'That is not valid JSON.' })
        return z.NEVER
      }
    }),
  live: z
    .union([z.literal('on'), z.literal('true'), z.literal('')])
    .optional()
    .transform((value) => value === 'on' || value === 'true'),
})

export const approvalSchema = z.object({
  stepId: z.string().min(1).max(64),
})
