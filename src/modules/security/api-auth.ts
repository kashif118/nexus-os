import type { Ctx } from '@/kernel/tenancy/ctx'

import { hashApiKey, readApiKey } from './keys'
import { contextForApiKey } from './service'

/**
 * Authenticate a request by API key.
 *
 * The boundary route handlers use, so they never import the service directly.
 * Returns a real `Ctx` — the same object a signed-in request produces — so
 * every service below behaves identically whether a person or a key called it.
 * There is deliberately no second, weaker authorization path.
 */
export async function authenticateApiRequest(
  request: Request,
): Promise<{ ctx: Ctx; keyId: string } | null> {
  const presented = readApiKey(request.headers)
  if (!presented) return null

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null

  return contextForApiKey(hashApiKey(presented), ip)
}
