# NEXUS OS — Q. Development Phases · R. Risks · S. Build Order · T. Decision Log

---

## Q. Development phases

I reordered the brief's 24 phases in three ways, each for a concrete reason:

1. **A new Phase 02 "Platform kernel"** comes before authentication. Errors, env config,
   logging, the action wrapper, the event outbox and the job runner are what every later
   phase plugs into. Retrofitting them after ten modules exist is the single most expensive
   mistake this project could make.
2. **Design system moves before the dashboard** (it was Phase 05 → now 06, ahead of any
   application screen). Building the Command Center first would set the visual language by
   accident.
3. **Testing is not a phase.** It runs inside every phase, with a dedicated hardening phase
   at the end for the cross-cutting suites (isolation matrix, authorization matrix, E2E).
   A phase is not "done" without its tests.

| #   | Phase                       | Ships                                                                                                                                            | Done when                                                                             |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 01  | **Foundation**              | Next.js 15 + TS strict, Tailwind v4, ESLint/boundaries, Prettier, Vitest, Playwright, CI, Prisma + Neon, `docs/`, `.env.example`                 | CI green on an empty app; `prisma migrate` runs                                       |
| 02  | **Platform kernel**         | `env`, `AppError`, logger, `getDb`/org extension, `createAction`, rate limiter, cache, outbox + dispatcher, job queue + cron drain, audit writer | a demo action writes an entity + audit + outbox event in one TX and a job consumes it |
| 03  | **Authentication**          | Auth.js v5, credentials + OAuth, verification, password reset, MFA, session records                                                              | full auth E2E passes; sessions revocable                                              |
| 04  | **Multi-tenancy**           | Organization, Membership, invitations, org switcher, `requireCtx`, `[orgSlug]` routing, isolation test harness                                   | isolation matrix passes for the models that exist                                     |
| 05  | **RBAC**                    | permission catalogue, roles seed, `can/require`, scope builders, role management UI, permission snapshot                                         | authorization matrix passes for all 7 roles                                           |
| 06  | **Design system**           | tokens (light/dark), themed shadcn, AppShell, sidebar, command palette, DataTable, forms, charts wrapper, empty/error/skeleton states            | Storybook-style kitchen-sink page; a11y check passes                                  |
| 07  | **Projects**                | projects, members, milestones, health scoring, detail shell, activity                                                                            | first real module end-to-end with tests                                               |
| 08  | **Tasks**                   | tasks, kanban + dnd-kit, dependencies, checklists, comments, mentions, My Work                                                                   | board persists, dependency cycles rejected                                            |
| 09  | **CRM**                     | companies, contacts, leads, pipelines, deals, stage history, activities, custom fields, tags, deal→project conversion                            | pipeline board + conversion flow works                                                |
| 10  | **People**                  | employees, teams, departments, skills, workload view, sensitive-field permissions                                                                | workload chart from real task data                                                    |
| 11  | **Finance**                 | invoices + items + numbering, payments, expenses, budgets, tax, PDF invoice, finance analytics                                                   | money math unit suite passes; totals never client-supplied                            |
| 12  | **Documents**               | folders, upload via presigned URL, versions, preview, permissions, polymorphic attachments                                                       | unauthorized download returns 404 in E2E                                              |
| 13  | **Communication**           | notifications + preferences, activity feeds, mentions, email delivery, digests                                                                   | notification fan-out driven by outbox events                                          |
| 14  | **Search + Command Center** | `SearchDocument` indexer, global search, widget registry, dashboard layout, alerts                                                               | search respects permissions; dashboard is configurable                                |
| 15  | **Workflow engine (core)**  | registries, graph validation, versions, runner, steps, retries, approvals, delays, run inspector                                                 | the §L.4 example workflow runs end to end                                             |
| 16  | **Workflow builder (UI)**   | visual canvas, node config forms generated from registries, condition builder, test run, templates                                               | a non-developer can build the example workflow                                        |
| 17  | **AI foundation**           | provider abstraction, model router, cost metering, redaction, tool framework, read tools, streaming assistant                                    | AI cannot access another org's data (tested)                                          |
| 18  | **AI agents**               | agent registry, runtime loop, memory, write tools with confirmation, the 7 agents, run transparency UI                                           | agent permissions = user permissions ∩ scope (tested)                                 |
| 19  | **AI intelligence**         | insight engine, inline actions, meeting pipeline, AI workflow actions, pgvector retrieval                                                        | insights cite their source records                                                    |
| 20  | **Analytics + reporting**   | metric engine, nightly rollups, charts, filters, drill-down, report templates, PDF/CSV export, scheduling                                        | executive report generated from real data                                             |
| 21  | **Security center + audit** | sessions UI, login history, audit viewer + export, API keys, security alerts, **Postgres RLS**, org security policies                            | RLS active; penetration checklist complete                                            |
| 22  | **Billing**                 | plans, Stripe checkout + portal + webhooks, entitlements service, usage metering, limit enforcement, upgrade prompts                             | limits enforced server-side; webhooks idempotent                                      |
| 23  | **Hardening**               | full isolation + authorization matrices, E2E journeys, load test on the top queries, `EXPLAIN` assertions, N+1 sweep, bundle budget, a11y audit  | performance and security gates green                                                  |
| 24  | **Production launch**       | Vercel prod, migrations, monitoring, alerts, backups + restore drill, runbooks, demo tenant seed                                                 | staging → production deploy documented and rehearsed                                  |
| 25  | **Presentation**            | README with screenshots + architecture diagrams, ADR set, demo video, live demo with seeded data, clean commit history                           | a reviewer can understand the system in 5 minutes                                     |

Realistic effort at senior pace: phases 01–06 ≈ 3 weeks, 07–14 ≈ 6 weeks, 15–19 ≈ 5 weeks,
20–25 ≈ 4 weeks. **≈ 18 weeks full-time.** If the timeline must compress, cut _scope inside_
modules (fewer CRM fields, no custom fields, one pipeline) — never cut phases 02, 04, 05, 21.

---

## R. Technical risks

| #   | Risk                                                                 | Likelihood / Impact | Mitigation                                                                                                                                           |
| --- | -------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Cross-tenant leak** — one forgotten `where` clause                 | Med / **Critical**  | 8 enforcement layers; Prisma extension makes the safe path the default; generated isolation matrix in CI; RLS in Phase 21                            |
| R2  | **Serverless timeouts** on workflows and agent loops                 | High / High         | step-level checkpointing + re-enqueue; wall-clock budget per job; `maxDuration` tuned; adapter ready for Inngest if needed                           |
| R3  | **Postgres connection exhaustion** from serverless fan-out           | High / High         | Neon serverless driver / PgBouncer transaction pooling; single Prisma instance per lambda; no long transactions                                      |
| R4  | **AI cost blowout**                                                  | Med / High          | model routing (cheap model for bulk summarization), token budgets per org/user, context truncation, caching, hard stop + kill switch, cost dashboard |
| R5  | **Prompt injection via client-supplied content**                     | Med / High          | tools authorized independently of the model; untrusted content delimited and labeled; write tools require confirmation; injection regression tests   |
| R6  | **Scope collapse** — 19 modules is a lot                             | **High** / High     | vertical slices: every phase ships a _working_ module; a strict "definition of done"; demo-able at the end of each phase                             |
| R7  | **N+1 and slow list queries** at realistic data volume               | High / Med          | repository-level `include` discipline, DataLoader-style batching where needed, seeded 100k-row dataset in staging, `EXPLAIN` assertions in CI        |
| R8  | **Event-loop / infinite automation** (workflow triggers itself)      | Med / High          | causation depth cap, self-trigger detection, per-org run quotas, circuit breaker per workflow                                                        |
| R9  | **Money correctness** (rounding, multi-currency, tax)                | Med / **High**      | integer minor units, `Decimal` for rates, totals only computed server-side from items, FX rate captured at write time, exhaustive unit tests         |
| R10 | **Migration mistakes** in production                                 | Med / High          | expand→migrate→contract, PR preview branches, review for lock duration, backfills as jobs, PITR                                                      |
| R11 | **Stripe webhook races / duplicates**                                | Med / Med           | `StripeEvent` idempotency table, signature + timestamp verification, reconciliation cron                                                             |
| R12 | **Timezone / working-day correctness** (deadlines, overdue, reports) | Med / Med           | org timezone stored and used everywhere; all comparisons in UTC with explicit conversion; injected clock in tests                                    |
| R13 | **Auth.js v5 gaps** (MFA, org concepts are ours to build)            | Med / Med           | accepted trade-off; auth is isolated behind `kernel/auth` so a vendor swap is contained                                                              |
| R14 | **Design consistency drift** across 19 modules                       | Med / Med           | design system + page templates before module work; DataTable/PageShell reused everywhere; a UI review checklist                                      |
| R15 | **Search scaling** beyond Postgres FTS                               | Low / Med           | `SearchDocument` is already an abstraction — swapping to Typesense/Meili is an indexer change, not a query-site change                               |
| R16 | **File storage abuse / malware**                                     | Low / High          | size and type caps, magic-byte validation, scan before availability, per-plan storage quota, attachment disposition                                  |

---

## S. What should be built first

**Phase 01 + 02 in one push — the foundation and the kernel — then a "walking skeleton".**

Concretely, the first deliverable I recommend (before any business module):

1. **Repo + toolchain** — Next.js 15/TS strict/Tailwind v4, ESLint with boundary rules,
   Prettier, Vitest, Playwright, GitHub Actions, `.env.example`, Zod-validated `env.ts`.
2. **Prisma schema for identity + tenancy only** — `User`, `Account`, `Session`,
   `Organization`, `Membership`, `Role`, `Permission`, `RolePermission`, `Invitation`,
   `AuditLog`, `OutboxEvent`, `Job` — plus the migration and the permission/role seed.
3. **The kernel** — `AppError` taxonomy, logger, `getDb(ctx)` with the org-scope extension,
   `requireCtx()`, `can/require`, `createAction()`, rate limiter, outbox writer, dispatcher
   and the cron-drained job runner.
4. **The walking skeleton** — sign up → verify → create organization → invite a second user →
   accept → switch organizations → one trivial entity (e.g. a Note) that proves the whole
   spine: validated action → permission check → org-scoped write → audit row → outbox event →
   job consumed → notification → visible in the UI.
5. **The isolation + authorization test harnesses**, wired into CI from day one so every
   later model is covered automatically.

Why this order: the walking skeleton is where multi-tenancy, RBAC, auditing and the event
backbone are proven _while the system is small enough to change_. Every later module is then
a repetition of a proven pattern. Building CRM or the dashboard first — the tempting,
demo-able choice — would mean rewriting every module once the kernel arrives.

Immediately after that: **Phase 06 (design system) → Phase 07 (Projects)**. Projects is the
right first business module because it sits at the centre of the entity graph (clients,
tasks, documents, finance all attach to it), so it forces the cross-module contracts to be
designed correctly and early.

---

## T. Decision log

| #   | Decision                                                    | Alternatives rejected                                       | Reason                                                                                                                  |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D1  | Single Next.js app, module boundaries enforced by lint      | Turborepo monorepo                                          | one deployable, no packaging ceremony; extraction stays mechanical                                                      |
| D2  | Auth.js v5 + DB sessions                                    | Clerk/WorkOS; hand-rolled                                   | the org model is the product and must stay ours; sessions must be revocable                                             |
| D3  | Shared DB + row-level tenant key                            | schema-per-tenant; DB-per-tenant                            | migration and cost sanity; layered enforcement recovers the safety                                                      |
| D4  | Org in the URL path                                         | subdomain; cookie-only                                      | simpler cookies/CSP; a stale cookie showing the wrong tenant is a dangerous bug class                                   |
| D5  | Prisma `$extends` org scoping                               | manual `where` discipline                                   | makes the safe path the default instead of a thing to remember                                                          |
| D6  | Transactional outbox + cron-drained job queue               | direct in-request side effects; external queue from day one | transactional guarantees, no extra vendor, adapter keeps the upgrade path open                                          |
| D7  | Server Actions + RSC over tRPC/REST for first-party traffic | tRPC                                                        | fewer layers, no duplicated DTOs; public REST still exists for integrations                                             |
| D8  | Own provider interface wrapping the AI SDK                  | use the AI SDK directly                                     | one seam for cost, redaction, audit, routing and provider swap                                                          |
| D9  | AI acts only through authorized tools                       | direct DB/RAG access for the model                          | the permission guarantee is otherwise unenforceable                                                                     |
| D10 | Money as integer minor units                                | Decimal columns; floats                                     | exactness and unambiguous arithmetic across currencies                                                                  |
| D11 | Workflow graph as a versioned validated DAG in JSON         | normalized trigger/condition/action tables                  | matches the visual builder, versions cleanly, still fully validated by Zod + a graph validator                          |
| D12 | RLS deferred to Phase 21                                    | RLS from day one                                            | it is defense-in-depth, not the primary control; adding it early would slow every migration before the model stabilizes |

---

## U. Implementation deviations from the specification

Recorded as they are discovered. The specification above was written against the versions
current at design time; these are the corrections found when the foundation was actually
built and verified (Phase 01).

| #   | Spec said                                             | Reality                                                                                                                                                       | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Next.js 15                                            | 16.3.6 is current stable                                                                                                                                      | Use 16. App Router, RSC and Server Actions are unchanged; `next lint` is gone, so ESLint runs as its own script, and the `eslint` key is no longer valid in `next.config.ts`.                                                                                                                                                                                                                                                                  |
| U2  | Prisma 6                                              | 7.10.0 stable (the `latest` tag points at an 8.0 release candidate)                                                                                           | Use 7.10.0 stable. **Two breaking changes matter:** connection URLs are no longer allowed in the schema's `datasource` block — the CLI reads them from `prisma.config.ts`, and the runtime requires a **driver adapter** passed to `PrismaClient`. Phase 02 therefore adds `@prisma/adapter-pg` (or the Neon adapter) when `lib/db.ts` is written. Prisma also no longer loads `.env` automatically, so `prisma.config.ts` does it explicitly. |
| U3  | Zod 3                                                 | Zod 4 stable                                                                                                                                                  | Use 4. `z.url()` replaces `z.string().url()`; issue types moved to `z.core.$ZodIssue`.                                                                                                                                                                                                                                                                                                                                                         |
| U4  | TypeScript "strict" (implicitly latest)               | TS 7 is stable but `typescript-eslint@8` declares `typescript <6.1.0`                                                                                         | Pin **TypeScript 5.9.3**. Revisit when typescript-eslint supports the native compiler.                                                                                                                                                                                                                                                                                                                                                         |
| U5  | ESLint 9 flat config                                  | ESLint 10 is current, but `eslint-plugin-react@7.37.5` (a dependency of `eslint-config-next`) supports only `<=9.x` and crashes on 10                         | Pin **ESLint 9.39.5**. Revisit when eslint-plugin-react ships ESLint 10 support.                                                                                                                                                                                                                                                                                                                                                               |
| U6  | `eslint-plugin-boundaries` with `element-types` rules | v7 replaced that rule with `boundaries/dependencies` + `policies`; elements classify **folders** and the new `boundaries/files` setting classifies **layers** | Config rewritten to the v7 model. The intra-module layering (transport / service / repository / db) is expressed as file categories. Verified by deliberately introducing violations and confirming the rule reports them.                                                                                                                                                                                                                     |
| U7  | Import resolution for boundary checks                 | `eslint-import-resolver-typescript@4` uses the new resolver interface that `eslint-module-utils` cannot load                                                  | Pin the resolver to **v3.10.1** (legacy interface, `interfaceVersion: 2`).                                                                                                                                                                                                                                                                                                                                                                     |
| U8  | —                                                     | npm 11 blocks dependency install scripts by default, so Prisma's engines are not downloaded on a plain `npm install`                                          | `allowScripts` entries are committed in `package.json`; the README documents `npm approve-scripts` + `npm rebuild` for first-time setup.                                                                                                                                                                                                                                                                                                       |
