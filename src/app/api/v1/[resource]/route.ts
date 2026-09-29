import { NextResponse } from 'next/server'

import { isAppError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'
import * as crm from '@/modules/crm/queries'
import * as finance from '@/modules/finance/queries'
import * as projects from '@/modules/projects/queries'
import { authenticateApiRequest } from '@/modules/security/api-auth'
import * as tasks from '@/modules/tasks/queries'

/**
 * The read-only public API.
 *
 * Authenticated by API key, and answered by the SAME query functions the
 * application's own pages call — so an integration sees exactly what the key's
 * creator would see, with every scope rule and every redaction applied, and
 * there is no second data path to keep in step.
 *
 * Deliberately read-only for now. A write API needs idempotency keys and a
 * request-signing story, and half of that is worse than none.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Resource = 'projects' | 'tasks' | 'invoices' | 'deals'

const RESOURCES: Record<
  Resource,
  { permission: string; fetch: (ctx: Ctx, params: ListParams<never>) => Promise<unknown> }
> = {
  projects: {
    permission: 'project.read.any',
    fetch: (ctx, params) => projects.listProjects(ctx, params as never),
  },
  tasks: {
    permission: 'task.read',
    fetch: (ctx, params) => tasks.listTasks(ctx, params as never),
  },
  invoices: {
    permission: 'finance.invoice.read',
    fetch: (ctx, params) => finance.listInvoices(ctx, params as never),
  },
  deals: {
    permission: 'crm.deal.read',
    fetch: (ctx, params) => crm.listDeals(ctx, params as never),
  },
}

export async function GET(request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params

  const definition = RESOURCES[resource as Resource]
  if (!definition) {
    return NextResponse.json({ error: 'Unknown resource.' }, { status: 404 })
  }

  const authenticated = await authenticateApiRequest(request)
  if (!authenticated) {
    return NextResponse.json(
      { error: 'Provide a valid API key in an Authorization: Bearer header.' },
      { status: 401 },
    )
  }

  const { ctx } = authenticated

  if (!ctx.can(definition.permission as never)) {
    return NextResponse.json(
      { error: 'This key does not have permission for that resource.' },
      { status: 403 },
    )
  }

  const url = new URL(request.url)
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25))
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)

  try {
    const result = await definition.fetch(ctx, {
      page,
      pageSize: limit,
      skip: (page - 1) * limit,
      take: limit,
      sort: { field: 'createdAt', direction: 'desc' },
      q: undefined,
    } as never)

    return NextResponse.json(
      { data: result },
      {
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    )
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json(
        { error: error.message },
        { status: error.code === 'FORBIDDEN' ? 403 : 400 },
      )
    }

    console.error('[api] request failed', { resource, error })
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
