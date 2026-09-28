import { CircleDashed, GitBranch, ShieldCheck, Workflow } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { ThemeToggle } from '@/components/theme-toggle'
import { clientEnv } from '@/kernel/config/env'

/**
 * Build status page for the foundation phase.
 *
 * This deliberately shows only what actually exists. No placeholder metrics, no
 * mock dashboard: the Command Center is Phase 14 and will be rendered from real
 * data (docs/ROADMAP.md §Q). Its purpose here is to prove the toolchain, the
 * design tokens and the theme switch work end to end.
 */

type PhaseState = 'complete' | 'next' | 'planned'

const PHASES: ReadonlyArray<{ id: string; name: string; state: PhaseState }> = [
  { id: '01', name: 'Foundation', state: 'complete' },
  { id: '02', name: 'Platform kernel', state: 'next' },
  { id: '03', name: 'Authentication', state: 'planned' },
  { id: '04', name: 'Multi-tenancy', state: 'planned' },
  { id: '05', name: 'RBAC', state: 'planned' },
  { id: '06', name: 'Design system', state: 'planned' },
  { id: '07', name: 'Projects', state: 'planned' },
  { id: '08', name: 'Tasks', state: 'planned' },
]

const FOUNDATION = [
  {
    Icon: GitBranch,
    title: 'Toolchain',
    body: 'Next.js 16 · React 19 · TypeScript strict with noUncheckedIndexedAccess · Tailwind v4 · Vitest · Playwright · GitHub Actions.',
  },
  {
    Icon: ShieldCheck,
    title: 'Configuration',
    body: 'Environment variables parsed by Zod at boot. process.env is unreadable outside the config kernel, and .env.example is diffed against the schema in CI.',
  },
  {
    Icon: Workflow,
    title: 'Layering',
    body: 'The app → transport → service → repository → db boundaries from the architecture are enforced by eslint-plugin-boundaries, not by review.',
  },
  {
    Icon: CircleDashed,
    title: 'Design tokens',
    body: 'One token set drives both themes. Components consume semantic variables, so no component holds a literal colour value.',
  },
]

const STATE_STYLES: Record<
  PhaseState,
  { variant: 'success' | 'default' | 'neutral'; label: string }
> = {
  complete: { variant: 'success', label: 'Complete' },
  next: { variant: 'default', label: 'Next' },
  planned: { variant: 'neutral', label: 'Planned' },
}

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-10 px-6 py-12 md:py-20">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="space-y-3">
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
            <Badge variant="outline">Phase 01</Badge>
          </div>
          <p className="text-muted-foreground max-w-xl text-sm leading-relaxed">
            An AI-powered business operating system. The foundation is in place; application modules
            are built phase by phase against the specification in{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">docs/</code>.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <Separator />

      <section aria-labelledby="foundation-heading" className="space-y-4">
        <h2 id="foundation-heading" className="text-sm font-semibold tracking-tight">
          What this phase established
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {FOUNDATION.map(({ Icon, title, body }) => (
            <Card key={title}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon className="text-primary size-4" aria-hidden="true" />
                  <CardTitle>{title}</CardTitle>
                </div>
                <CardDescription className="leading-relaxed">{body}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="phases-heading" className="space-y-4">
        <h2 id="phases-heading" className="text-sm font-semibold tracking-tight">
          Build order
        </h2>
        <Card>
          <CardContent className="divide-border divide-y pt-0">
            {PHASES.map((phase) => {
              const state = STATE_STYLES[phase.state]
              return (
                <div key={phase.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground tabular font-mono text-xs">
                      {phase.id}
                    </span>
                    <span className="text-sm font-medium">{phase.name}</span>
                  </div>
                  <Badge variant={state.variant}>{state.label}</Badge>
                </div>
              )
            })}
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-xs">
          Full phase plan: <code className="font-mono">docs/ROADMAP.md</code> §Q. Twenty-five
          phases; the eight above are the near term.
        </p>
      </section>
    </main>
  )
}
