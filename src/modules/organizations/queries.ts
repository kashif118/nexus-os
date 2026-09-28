import type { Ctx } from '@/kernel/tenancy/ctx'

import * as service from './service'

/**
 * Read boundary for Server Components. The UI layer cannot import a service
 * directly (enforced by the lint boundary rules), so reads funnel through here.
 */

export async function getOrganization(ctx: Ctx) {
  return service.getOrganization(ctx)
}

export async function listMembers(ctx: Ctx) {
  return service.listMembers(ctx)
}

export async function listPendingInvitations(ctx: Ctx) {
  return service.listPendingInvitations(ctx)
}

export async function listMyOrganizations(userId: string) {
  return service.listMyOrganizations(userId)
}

export async function previewInvitation(token: string, userEmail: string) {
  return service.previewInvitation(token, userEmail)
}
