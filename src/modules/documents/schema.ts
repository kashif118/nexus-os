import { z } from 'zod'

export const DOCUMENT_VISIBILITIES = ['ORGANIZATION', 'RESTRICTED', 'PRIVATE'] as const
export const GRANT_ACCESS = ['VIEW', 'EDIT', 'MANAGE'] as const
export const GRANT_SUBJECTS = ['USER', 'ROLE', 'TEAM'] as const

export const DOCUMENT_SORT_FIELDS = ['name', 'createdAt', 'updatedAt', 'sizeBytes'] as const
export type DocumentSort = (typeof DOCUMENT_SORT_FIELDS)[number]

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

/**
 * A folder name, constrained so it can safely become part of a materialized
 * path. Slashes are excluded because the path uses them as its separator.
 */
export const folderSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a folder name.')
    .max(80)
    .refine((value) => !value.includes('/'), 'A folder name cannot contain a slash.'),
  parentId: optionalId,
})

export const documentUpdateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'Enter a name.').max(200),
  description: optionalText(1000),
  folderId: z.string().trim().max(64).optional(),
  visibility: z.enum(DOCUMENT_VISIBILITIES),
})

export const shareSchema = z.object({
  documentId: z.string().min(1).max(64),
  subjectType: z.enum(GRANT_SUBJECTS),
  subjectId: z.string().min(1).max(64),
  access: z.enum(GRANT_ACCESS).default('VIEW'),
})

export const revokeSchema = z.object({
  documentId: z.string().min(1).max(64),
  grantId: z.string().min(1).max(64),
})

export const attachSchema = z.object({
  documentId: z.string().min(1).max(64),
  entityType: z.enum(['Task', 'Project', 'Deal', 'Invoice', 'Company', 'Expense']),
  entityId: z.string().min(1).max(64),
})

export const idSchema = z.object({ id: z.string().min(1).max(64) })

/**
 * Upload metadata that travels alongside the file in the multipart body.
 *
 * The file itself is validated by `inspectUpload` rather than here: Zod can
 * check that a field is a string, but only the bytes can say what a file is.
 */
export const uploadMetaSchema = z.object({
  folderId: optionalId,
  projectId: optionalId,
  description: optionalText(1000),
  visibility: z.enum(DOCUMENT_VISIBILITIES).default('ORGANIZATION'),
})
