import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { clientEnv } from '@/kernel/config/env'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { CREATOR, creatorInitials } from '@/lib/creator'

export const metadata: Metadata = { title: 'About' }

/**
 * About and credits.
 *
 * Under settings rather than in the main navigation: it is a thing you look for
 * once, not a thing you work in.
 *
 * Every figure below is either a constant of the build or read from
 * configuration. Nothing here is computed from tenant data, so this page is
 * readable by any member and exposes nothing about the organization.
 */

const CAPABILITIES = [
  'Clients, pipeline and deals',
  'Projects, milestones and budgets',
  'Tasks with blocking dependencies',
  'People, teams and workload',
  'Invoices, payments and expenses',
  'Versioned documents with per-document sharing',
  'A workflow engine with approvals and delays',
  'AI agents that propose, and people who dispose',
  'Analytics and reports computed live',
  'Sessions, audit log, API keys and security policy',
]

export default async function AboutPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  await requireCtxPage(orgSlug)

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader
        title="About"
        description={`What ${clientEnv.NEXT_PUBLIC_APP_NAME} is, and who built it.`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{clientEnv.NEXT_PUBLIC_APP_NAME}</CardTitle>
          <CardDescription>
            An AI-powered business operating system: the work, the money and the people in one
            place, with every organization&rsquo;s data isolated at the database layer rather than
            by a filter somebody has to remember to write.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <ul className="text-muted-foreground grid gap-1.5 text-sm sm:grid-cols-2">
            {CAPABILITIES.map((capability) => (
              <li key={capability} className="flex gap-2">
                <span aria-hidden="true">·</span>
                {capability}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credits</CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            {/*
              A placeholder until a real image exists. Rendering initials is
              honest; a stock photograph or a generated face would not be.
              Setting `CREATOR.avatarUrl` to a path under `public/` replaces it.
            */}
            {CREATOR.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={CREATOR.avatarUrl}
                alt=""
                className="size-14 rounded-full object-cover"
                width={56}
                height={56}
              />
            ) : (
              <div
                aria-hidden="true"
                className="bg-muted text-muted-foreground grid size-14 shrink-0 place-items-center rounded-full text-base font-semibold"
              >
                {creatorInitials()}
              </div>
            )}

            <div className="space-y-0.5">
              <p className="font-medium">Built by {CREATOR.name}</p>
              <p className="text-muted-foreground text-sm">{CREATOR.role}</p>
              <a
                href={`mailto:${CREATOR.email}`}
                className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
              >
                {CREATOR.email}
              </a>
            </div>
          </div>

          <Separator />

          <p className="text-muted-foreground text-sm leading-relaxed">
            Built with Next.js, React, TypeScript, PostgreSQL and Prisma. The architecture, the
            decisions behind it and every deviation from the original specification are recorded in
            the <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">docs/</code>{' '}
            directory of the repository — including an engineering report that is explicit about
            what has not been verified.
          </p>
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        <Link href={`/${orgSlug}/settings`} className="underline underline-offset-4">
          Back to settings
        </Link>
      </p>
    </div>
  )
}
