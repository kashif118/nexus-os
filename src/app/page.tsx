import {
  BarChart3,
  Bot,
  Briefcase,
  FileText,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  Workflow,
} from 'lucide-react'
import Link from 'next/link'

import { ThemeToggle } from '@/components/theme-toggle'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { clientEnv } from '@/kernel/config/env'

/**
 * The front door.
 *
 * The only page a signed-out visitor sees, so it has one job: say what this is
 * and get them to an account. Every claim below names something that exists and
 * can be used within a minute of signing up — there are no screenshots of
 * features that are not here, and no numbers invented to look impressive.
 */

const MODULES = [
  {
    Icon: Briefcase,
    title: 'Clients and pipeline',
    body: 'Companies, contacts, leads and a drag-and-drop deal pipeline. A lead converts into a company, a contact and a deal in one step, with the history kept.',
  },
  {
    Icon: Workflow,
    title: 'Projects and tasks',
    body: 'Projects with members, milestones and budgets; tasks on a board with dependencies, checklists and comments. A task that is blocked says what by.',
  },
  {
    Icon: Wallet,
    title: 'Money',
    body: 'Invoices, payments, expenses and budgets in integer minor units — no floating point anywhere on a money path. An invoice is paid because payments add up to it, not because somebody pressed a button.',
  },
  {
    Icon: Users,
    title: 'People',
    body: 'Profiles, teams, departments, skills and a workload view that reads real assignments. Pay information is a separate permission from everything else.',
  },
  {
    Icon: FileText,
    title: 'Documents',
    body: 'Versioned files with folders, per-document sharing and attachment to any record. A private document stays private when the link is guessed.',
  },
  {
    Icon: BarChart3,
    title: 'Analytics and reports',
    body: 'Metrics computed live from your own records, with period comparison and drill-down. Reports are parameters, not snapshots, so reopening one recomputes it.',
  },
  {
    Icon: Sparkles,
    title: 'Automation',
    body: 'A visual workflow engine: triggers, conditions, approvals and delays. Runs are resumable, and every step is recorded.',
  },
  {
    Icon: Bot,
    title: 'AI agents',
    body: 'Agents that propose and people who dispose. An agent works through the same authorization as a person, and nothing it suggests happens until somebody accepts it.',
  },
  {
    Icon: ShieldCheck,
    title: 'Security',
    body: 'Sessions, login history, an audit log, API keys and org security policies. Seven roles, 109 permissions, and a denial that beats any grant.',
  },
]

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-12 px-6 py-10 md:py-16">
      <header className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="bg-primary text-primary-foreground grid size-9 place-items-center rounded-lg font-mono text-sm font-bold"
          >
            N
          </div>
          <span className="text-lg font-semibold tracking-tight">
            {clientEnv.NEXT_PUBLIC_APP_NAME}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/sign-in" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Sign in
          </Link>
          <Link href="/sign-up" className={buttonVariants({ size: 'sm' })}>
            Create an account
          </Link>
        </div>
      </header>

      <main className="space-y-12">
        <section className="max-w-3xl space-y-5">
          <h1 className="text-3xl font-semibold tracking-tight text-balance md:text-4xl">
            One system for the work, the money and the people.
          </h1>
          <p className="text-muted-foreground text-base leading-relaxed">
            Most companies run on five tools that disagree with each other. {}
            {clientEnv.NEXT_PUBLIC_APP_NAME} is a single operating system for a business: clients,
            projects, tasks, invoices, people and documents in one place, with an automation engine
            and AI agents that work through the same permissions a person does.
          </p>
          <p className="text-muted-foreground text-base leading-relaxed">
            Every organization&rsquo;s data is isolated at the database layer, not by a filter
            somebody has to remember to write. The invoice on the finance page is the same row the
            dashboard counts.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link href="/sign-up" className={buttonVariants()}>
              Create an organization
            </Link>
            <Link href="/sign-in" className={buttonVariants({ variant: 'outline' })}>
              Sign in
            </Link>
          </div>
          <p className="text-muted-foreground text-xs">
            Free to start: ten members, ten projects, 2&nbsp;GB of documents. No card.
          </p>
        </section>

        <Separator />

        <section aria-labelledby="modules-heading" className="space-y-5">
          <h2 id="modules-heading" className="text-sm font-semibold tracking-tight">
            What is in it
          </h2>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map(({ Icon, title, body }) => (
              <Card key={title}>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Icon className="text-primary size-4" aria-hidden="true" />
                    <CardTitle className="text-base">{title}</CardTitle>
                  </div>
                  <CardDescription className="leading-relaxed">{body}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="text-muted-foreground mt-auto space-y-2 text-xs">
        <Separator className="mb-6" />
        <p>
          {clientEnv.NEXT_PUBLIC_APP_NAME} — an AI-powered business operating system. AI features
          require a provider key; without one the assistant says so rather than inventing an answer.
        </p>
      </footer>
    </div>
  )
}
