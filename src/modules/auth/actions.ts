'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { writeAuditLog } from '@/kernel/audit/write'
import { requireUser, safeRedirectPath } from '@/kernel/auth/guards'
import {
  createSession,
  destroyCurrentSession,
  getRequestContext,
  revokeAllSessions,
  revokeSession,
} from '@/kernel/auth/session'
import { toActionResult, type ActionResult } from '@/kernel/errors'
import { readLastOrg } from '@/kernel/tenancy/last-org'
import { resolveLandingPath } from '@/modules/organizations/service'

import {
  requestPasswordResetSchema,
  resetPasswordSchema,
  revokeSessionSchema,
  signInSchema,
  signUpSchema,
  verifyEmailSchema,
} from './schema'
import * as service from './service'

/**
 * Server Actions for authentication (docs/OPERATIONS.md §M.2).
 *
 * Each action does the same four things and nothing else: parse input with Zod,
 * call the service, translate thrown `AppError`s into a typed result, and manage
 * the session cookie. Business rules live in the service; these never make a
 * security decision of their own.
 *
 * `useActionState` drives the forms, so every action takes the previous state as
 * its first argument and returns a serialisable result. Forms therefore work
 * without client-side JavaScript.
 *
 * The generic `createAction()` wrapper from §M.2 — which will fold in rate
 * limiting, permissions and audit declaratively — arrives with the platform
 * kernel. These actions already do each of those steps explicitly.
 */

export type FormState = ActionResult<{ message?: string }> | null

function parseFormData<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  formData: FormData,
): { ok: true; data: T } | { ok: false; result: ActionResult<never> } {
  const raw = Object.fromEntries(formData.entries())
  const parsed = schema.safeParse(raw)

  if (!parsed.success || parsed.data === undefined) {
    const fields: Record<string, string[]> = {}
    const issues = (parsed.error as { issues?: Array<{ path: PropertyKey[]; message: string }> })
      ?.issues

    for (const issue of issues ?? []) {
      const key = String(issue.path[0] ?? 'form')
      ;(fields[key] ??= []).push(issue.message)
    }

    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Check the highlighted fields.', fields },
      },
    }
  }

  return { ok: true, data: parsed.data }
}

/* -------------------------------------------------------------------------- */

export async function signUpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseFormData(signUpSchema, formData)
  if (!parsed.ok) return parsed.result

  const meta = await getRequestContext()

  try {
    const { userId } = await service.register(parsed.data, meta)
    // Registration signs the user straight in; the address is verified
    // afterwards, so an unverified account is usable but marked.
    await createSession(userId, meta)
  } catch (error) {
    return toActionResult(error)
  }

  // A brand-new account belongs to no organization yet.
  redirect('/organizations/new')
}

export async function signInAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseFormData(signInSchema, formData)
  if (!parsed.ok) return parsed.result

  const meta = await getRequestContext()

  let destination: string
  try {
    const { userId } = await service.authenticate(
      { email: parsed.data.email, password: parsed.data.password },
      meta,
    )
    // A new session on every sign-in — no fixation carried over from a
    // pre-authentication cookie.
    await createSession(userId, meta)

    // An explicit destination wins; otherwise land in an organization rather
    // than a bare account page.
    destination = parsed.data.next
      ? safeRedirectPath(parsed.data.next)
      : await resolveLandingPath(userId, await readLastOrg())
  } catch (error) {
    return toActionResult(error)
  }

  redirect(destination)
}

export async function signOutAction(): Promise<never> {
  const session = await requireUser().catch(() => null)
  const meta = await getRequestContext()

  await destroyCurrentSession()

  if (session) {
    await writeAuditLog({
      action: 'auth.signed_out',
      entityType: 'Session',
      entityId: session.sessionId,
      actorId: session.user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
  }

  redirect('/sign-in')
}

export async function verifyEmailAction(token: string): Promise<ActionResult<{ message: string }>> {
  const parsed = verifyEmailSchema.safeParse({ token })
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'That verification link is not valid.' },
    }
  }

  const meta = await getRequestContext()

  try {
    await service.verifyEmail(parsed.data.token, meta)
    return { ok: true, data: { message: 'Your email address is confirmed.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function resendVerificationAction(): Promise<FormState> {
  const meta = await getRequestContext()

  try {
    const session = await requireUser()
    if (session.user.emailVerifiedAt) {
      return { ok: true, data: { message: 'Your email address is already confirmed.' } }
    }

    await service.sendEmailVerification(session.user.email, { throttle: true })
    await writeAuditLog({
      action: 'auth.verification_resent',
      entityType: 'User',
      entityId: session.user.id,
      actorId: session.user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    return { ok: true, data: { message: 'Confirmation email sent.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function requestPasswordResetAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(requestPasswordResetSchema, formData)
  if (!parsed.ok) return parsed.result

  const meta = await getRequestContext()

  try {
    await service.requestPasswordReset(parsed.data.email, meta)
  } catch (error) {
    return toActionResult(error)
  }

  // Identical response whether or not the address is registered.
  return {
    ok: true,
    data: {
      message:
        'If an account exists for that address, a reset link is on its way. Check your inbox.',
    },
  }
}

export async function resetPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(resetPasswordSchema, formData)
  if (!parsed.ok) return parsed.result

  const meta = await getRequestContext()

  try {
    const { userId } = await service.resetPassword(parsed.data, meta)

    // Everything else is signed out: a reset is the remedy for a compromised
    // account, so any session an attacker holds must die with it.
    await revokeAllSessions(userId, { reason: 'password_reset' })
    await createSession(userId, meta)
  } catch (error) {
    return toActionResult(error)
  }

  redirect('/account')
}

export async function revokeSessionAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = parseFormData(revokeSessionSchema, formData)
  if (!parsed.ok) return parsed.result

  try {
    const session = await requireUser()
    const meta = await getRequestContext()

    if (parsed.data.sessionId === session.sessionId) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'That is your current session. Use sign out instead.',
        },
      }
    }

    // Scoped to the caller inside the query — a guessed id revokes nothing.
    const revoked = await revokeSession(session.user.id, parsed.data.sessionId)
    if (revoked === 0) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'That session is no longer active.' },
      }
    }

    await writeAuditLog({
      action: 'auth.session_revoked',
      entityType: 'Session',
      entityId: parsed.data.sessionId,
      actorId: session.user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    revalidatePath('/account')
    return { ok: true, data: { message: 'Session signed out.' } }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function revokeOtherSessionsAction(): Promise<FormState> {
  try {
    const session = await requireUser()
    const meta = await getRequestContext()

    const count = await revokeAllSessions(session.user.id, {
      exceptSessionId: session.sessionId,
      reason: 'revoked_all_by_user',
    })

    await writeAuditLog({
      action: 'auth.sessions_revoked_all',
      entityType: 'User',
      entityId: session.user.id,
      actorId: session.user.id,
      metadata: { count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    revalidatePath('/account')
    return {
      ok: true,
      data: {
        message:
          count === 0 ? 'No other sessions were active.' : `Signed out ${count} other session(s).`,
      },
    }
  } catch (error) {
    return toActionResult(error)
  }
}
