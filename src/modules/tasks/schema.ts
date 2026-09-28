import { z } from 'zod'

export const TASK_STATUSES = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'REVIEW',
  'DONE',
  'CANCELLED',
] as const

/** Columns shown on the board, in order. CANCELLED is deliberately excluded. */
export const BOARD_COLUMNS = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const
export const DEPENDENCY_TYPES = ['FINISH_START', 'START_START', 'FINISH_FINISH'] as const

export const TASK_SORT_FIELDS = [
  'number',
  'title',
  'status',
  'priority',
  'dueDate',
  'createdAt',
] as const

export type TaskSort = (typeof TASK_SORT_FIELDS)[number]

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

export const taskInputSchema = z.object({
  title: z.string().trim().min(1, 'Enter a task title.').max(200),
  description: optionalText(8000),
  projectId: optionalId,
  milestoneId: optionalId,
  parentTaskId: optionalId,
  status: z.enum(TASK_STATUSES).default('BACKLOG'),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
  assigneeMembershipId: optionalId,
  startDate: optionalDate,
  dueDate: optionalDate,
  estimateMinutes: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? Number(value) : undefined))
    .refine(
      (value) => value === undefined || (Number.isInteger(value) && value >= 0 && value <= 100_000),
      'Enter a whole number of minutes.',
    ),
})

export const moveTaskSchema = z.object({
  taskId: z.string().min(1).max(64),
  status: z.enum(TASK_STATUSES),
  beforeId: optionalId,
  afterId: optionalId,
})

export const assignTaskSchema = z.object({
  taskId: z.string().min(1).max(64),
  membershipId: optionalId,
})

export const dependencySchema = z.object({
  taskId: z.string().min(1).max(64),
  dependsOnTaskId: z.string().min(1).max(64),
  type: z.enum(DEPENDENCY_TYPES).default('FINISH_START'),
})

export const removeDependencySchema = z.object({
  taskId: z.string().min(1).max(64),
  dependsOnTaskId: z.string().min(1).max(64),
})

export const checklistItemSchema = z.object({
  taskId: z.string().min(1).max(64),
  content: z.string().trim().min(1, 'Enter something to do.').max(300),
})

export const toggleChecklistSchema = z.object({
  taskId: z.string().min(1).max(64),
  itemId: z.string().min(1).max(64),
  done: z
    .union([z.literal('on'), z.literal('true'), z.literal('false'), z.literal('')])
    .optional()
    .transform((value) => value === 'on' || value === 'true'),
})

export const commentSchema = z.object({
  taskId: z.string().min(1).max(64),
  body: z.string().trim().min(1, 'Write something.').max(8000),
})

export const labelSchema = z.object({
  name: z.string().trim().min(1, 'Enter a label name.').max(40),
  color: z.enum(['neutral', 'info', 'success', 'warning', 'destructive']).default('neutral'),
})

export const taskLabelSchema = z.object({
  taskId: z.string().min(1).max(64),
  labelId: z.string().min(1).max(64),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })
