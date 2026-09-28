/**
 * Error taxonomy (docs/OPERATIONS.md §M.6).
 *
 * Two rules the rest of the codebase depends on:
 *
 * 1. **Nothing internal reaches the user.** An `AppError` carries a message that
 *    is safe to display; anything else is reported as a generic
 *    `INTERNAL_ERROR` with a reference id, and the detail goes to the log.
 * 2. **Cross-tenant and unknown-record access are both `NOT_FOUND`.** Returning
 *    403 for a record in another organization confirms that it exists.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'ENTITLEMENT_REQUIRED',
  'EXTERNAL_SERVICE_ERROR',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  ENTITLEMENT_REQUIRED: 402,
  EXTERNAL_SERVICE_ERROR: 502,
  INTERNAL_ERROR: 500,
}

/** Field-level messages, keyed by form field name. */
export type FieldErrors = Record<string, string[]>

export interface AppErrorOptions {
  /** Messages for individual form fields. */
  fields?: FieldErrors
  /** Structured context for the log — never sent to the client. */
  meta?: Record<string, unknown>
  /** Seconds until the caller may retry. Only meaningful for RATE_LIMITED. */
  retryAfterSeconds?: number
  cause?: unknown
}

/**
 * An error whose message is safe to show to the user. Anything thrown that is
 * not an `AppError` is treated as a bug and reported generically.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly fields: FieldErrors | undefined
  readonly meta: Record<string, unknown> | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.fields = options.fields
    this.meta = options.meta
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError

export const validationError = (message: string, fields?: FieldErrors) =>
  new AppError('VALIDATION_ERROR', message, fields ? { fields } : {})

export const unauthenticated = (message = 'You need to sign in to continue.') =>
  new AppError('UNAUTHENTICATED', message)

export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError('FORBIDDEN', message)

export const notFound = (message = 'Not found.') => new AppError('NOT_FOUND', message)

export const conflict = (message: string, fields?: FieldErrors) =>
  new AppError('CONFLICT', message, fields ? { fields } : {})

export const rateLimited = (message: string, retryAfterSeconds: number) =>
  new AppError('RATE_LIMITED', message, { retryAfterSeconds })

export const externalServiceError = (message: string, cause?: unknown) =>
  new AppError('EXTERNAL_SERVICE_ERROR', message, { cause })

/* -------------------------------------------------------------------------- */
/* Transport mapping                                                           */
/* -------------------------------------------------------------------------- */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false
      error: {
        code: ErrorCode
        message: string
        fields?: FieldErrors
        retryAfterSeconds?: number
      }
    }

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data })

const GENERIC_MESSAGE = 'Something went wrong. Please try again.'

/**
 * Convert any thrown value into a result safe to return to the client.
 *
 * Unknown errors deliberately lose their message and stack: they may contain a
 * connection string, a SQL fragment or a provider response.
 */
export function toActionResult(error: unknown): ActionResult<never> {
  if (isAppError(error)) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    }
  }

  return { ok: false, error: { code: 'INTERNAL_ERROR', message: GENERIC_MESSAGE } }
}
