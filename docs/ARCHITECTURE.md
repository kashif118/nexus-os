# NEXUS OS — Architecture Specification

**Version:** 0.1 (pre-implementation)
**Status:** Awaiting approval. No application code written yet.

| Document                      | Contents                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| `ARCHITECTURE.md` (this file) | A. Product · B. System · C. Modules · D. Tech stack          |
| `DATA-MODEL.md`               | E. Database entity map, relationships, indexes, isolation    |
| `PLATFORM.md`                 | F. Folder structure · G. Auth · H. Multi-tenancy · I. RBAC   |
| `AI-AND-AUTOMATION.md`        | J. AI · K. Agents · L. Workflow engine                       |
| `OPERATIONS.md`               | M. API · N. Security · O. Testing · P. Deployment · Env vars |
| `ROADMAP.md`                  | Q. Phases · R. Risks · S. What to build first · Decision log |

---

## 0. How to read this document

This is the contract the implementation must satisfy. Every phase of work references a
section here. When a decision changes during implementation it is changed **here first**,
with the reason recorded in the Decision Log (`ROADMAP.md` §T).

Conventions used throughout:

- **Tenant** = `Organization`. Every business record belongs to exactly one organization.
- **Actor** = the authenticated `User` acting _inside_ a specific organization.
- **Ctx** = `{ userId, orgId, membershipId, roles, permissions: Set<string>, requestId, actorType }`.
  Nothing reads or writes tenant data without a Ctx.
- **Money** is stored as an integer in **minor units** plus an ISO-4217 currency code.
  Floating point is banned in the finance domain.

---

## A. Product architecture

### A.1 Positioning

NEXUS OS is a **business operating system**: the single place where a company's work,
money, people, clients, documents and decisions live — with an AI layer that can read and
act on all of it _inside the acting user's permission boundary_.

The product identity is **Command Center + Automation Engine + Agent layer**.
CRM, Projects and Finance are _applications running on the OS_, not the product itself.

Three product-level principles follow from that:

1. **Everything is one graph.** A deal links to a project, which links to tasks, documents,
   invoices, expenses and an activity stream. The value of the product is the joins —
   features that only exist in one silo are low priority.
2. **Everything emits events.** Every meaningful state change publishes a domain event.
   Automation, notifications, analytics, audit and search are all _subscribers_. This is
   what makes the platform extensible instead of a pile of features.
3. **AI is a first-class actor, not a sidebar.** Agents carry a permission scope, call the
   same service layer humans do, and are audited like humans.

### A.2 Product surface map

```
                         ┌──────────────────────────┐
                         │   EXECUTIVE COMMAND      │   the "home" of the OS
                         │   CENTER  (widget grid)  │
                         └────────────┬─────────────┘
                                      │ reads
  ┌───────────┬───────────┬───────────┼───────────┬───────────┬───────────┐
  │   CRM     │ PROJECTS  │  TASKS    │  PEOPLE   │  FINANCE  │ DOCUMENTS │  applications
  └─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┘
        │           │           │           │           │           │
        └───────────┴──────── domain events ────────────┴───────────┘
                                      │
        ┌─────────────┬───────────────┼───────────────┬──────────────┐
        │  WORKFLOW   │ NOTIFICATIONS │   ANALYTICS   │    SEARCH    │  platform services
        │  AUTOMATION │               │  + REPORTING  │    + AUDIT   │
        └─────────────┴───────────────┴───────────────┴──────────────┘
                                      │
                         ┌────────────┴─────────────┐
                         │ AI INTELLIGENCE + AGENTS │  act through tools → services
                         └──────────────────────────┘
```

### A.3 Personas and their primary surface

| Persona                  | Primary surface                            | Job to be done                            |
| ------------------------ | ------------------------------------------ | ----------------------------------------- |
| Founder / Exec (Owner)   | Command Center, Reports, Executive Agent   | "What needs my attention today?"          |
| Delivery / Ops Manager   | Projects, Tasks, Workload, Project Agent   | keep delivery on track                    |
| Sales (Manager/Employee) | CRM pipeline, Deals, CRM Agent             | move deals, convert won deals to projects |
| Finance Manager          | Invoices, Expenses, Budgets, Finance Agent | cash in / cash out, chase overdue         |
| HR Manager               | People, Teams, Departments, Skills         | staffing and workload balance             |
| Employee                 | My Work, Documents, Comments               | execute assigned work                     |
| Client (external)        | Client Portal — read-only scoped subset    | project status, invoices                  |
| Admin                    | Settings, Roles, Security Center, Audit    | governance and compliance                 |

### A.4 Cross-module integration contracts (the joins that make it an OS)

| From → To                   | Contract                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Deal won → Project          | one-click conversion: deal value seeds project budget, contact becomes client, deal activities copied to project activity |
| Project → Finance           | project budget vs. actual (expenses + logged cost); invoice can be raised _from_ a project and its milestones             |
| Task → Analytics            | completion/overdue events feed throughput and workload metrics                                                            |
| Any entity → Documents      | polymorphic attachment (`entityType`, `entityId`) with inherited access                                                   |
| Any entity → Activity/Audit | every write produces an activity item and an audit record                                                                 |
| Any event → Workflow        | the trigger catalogue is the event catalogue                                                                              |
| Everything → Search         | outbox-driven denormalized `SearchDocument` rows                                                                          |

### A.5 Non-goals for v1

Real-time collaborative editing, email inbox sync, video meetings, native mobile apps,
third-party plugin marketplace, per-tenant custom code, time tracking with payroll.
The architecture leaves room for all of them (events + adapters); none are in scope.

---

## B. High-level system architecture

### B.1 Runtime topology

```
 Browser  (Next.js App Router — RSC shell + client islands)
   │ HTTPS
   ▼
 Vercel Edge middleware  (session cookie check, org slug resolution,
   │                      rate-limit bucket, CSP nonce, security headers)
   ▼
 Next.js Node runtime ──────────────────────────────────────────────┐
   ├─ Server Components    read path  → queries → services          │
   ├─ Server Actions       write path → validated commands          │
   ├─ Route Handlers       webhooks · AI streaming · file signing · │
   │                       cron · public API v1                     │
   │                                                                │
   ├── SERVICE LAYER   business rules · authorization · transactions│
   │      ├─ writes AuditLog        (same TX)                       │
   │      └─ writes OutboxEvent     (same TX)                       │
   ├── REPOSITORY LAYER   Prisma only, org-scoped by client extension│
   └── ADAPTERS  AI · Storage · Email · Payments · Queue · Cache ───┘
        │         │         │         │         │         │
        ▼         ▼         ▼         ▼         ▼         ▼
    Anthropic   S3/R2    Resend    Stripe    JobQueue   Upstash
   (swappable) presigned           webhooks  (DB+cron)   Redis

 Background plane
   Vercel Cron (* * * * *) → POST /api/jobs/drain  (authenticated by CRON_SECRET)
     ├─ drain OutboxEvent → WorkflowEngine · NotificationService ·
     │                      SearchIndexer · AnalyticsRollup
     ├─ resume paused WorkflowRuns (delays, approvals, retries)
     └─ scheduled jobs: nightly metric rollups, overdue sweeps,
        digest emails, subscription reconciliation, dead-letter alerts
```

### B.2 Layering rules

```
app/**                          UI: RSC pages, client islands
  ↓ may import
modules/<m>/actions|queries     transport + command boundary (Zod, Ctx, rate limit)
  ↓ may import
modules/<m>/service             business logic, authorization, transactions, events
  ↓ may import
modules/<m>/repository          Prisma access only
  ↓
lib/db                          Prisma client + org-scope extension
```

Hard rules, mechanically enforced by `eslint-plugin-boundaries`:

- UI **never** imports Prisma or a repository.
- AI tools **never** import Prisma; they call services with a Ctx.
- Services **never** import React, `next/headers`, or `next/navigation`.
- Cross-module calls are **service → service**, never repository → repository.
- Every exported service function takes `ctx: Ctx` as its first parameter.
- Repositories never contain authorization logic; services never contain SQL.

### B.3 Request lifecycles

**Read (RSC page):**
`page.tsx` → `requireCtx()` (session + membership + permissions) → `queries.listProjects(ctx, filters)`
→ service applies permission scoping → repository issues an org-scoped Prisma query
→ RSC renders → client islands hydrate for interactivity only.

**Write (Server Action):**
client form → action wrapped by `createAction()` → rate limit → Zod parse → build Ctx →
`ctx.require('project.update')` → service → **single transaction**: entity write + AuditLog

- OutboxEvent → `revalidateTag()` → typed result `{ ok } | { error }` → toast.

**Async (after commit):**
cron drain → dispatcher loads subscribers for `project.updated` → WorkflowEngine matches
triggers and enqueues runs; NotificationService fans out per user preference;
SearchIndexer upserts `SearchDocument`; AnalyticsRollup marks the day dirty.

### B.4 Why the event backbone matters

Every mutation writes, in one transaction: (1) the entity change, (2) an `AuditLog` row,
(3) an `OutboxEvent` row. A cron-driven runner drains the outbox at-least-once with
exponential backoff and a dead-letter queue.

This buys us: no "task created but automation never fired" class of bug; replayable
history; a _single_ place to add any new cross-cutting feature; and a natural trigger
catalogue for the workflow engine (the trigger list **is** the event list).

Consumers must be **idempotent** — every handler keys off `(eventId, subscriberId)` in a
`OutboxDelivery` table.

---

## C. Complete module list

### C.1 Platform kernel (not user-visible; built first)

| Module                 | Responsibility                                                         |
| ---------------------- | ---------------------------------------------------------------------- |
| `kernel/auth`          | credentials + OAuth, sessions, MFA, email verification, password reset |
| `kernel/tenancy`       | org resolution, org switching, membership lifecycle, invitations       |
| `kernel/authz`         | roles, permissions, `can()` / `require()`, record-level policies       |
| `kernel/errors`        | `AppError` taxonomy, safe mapping to HTTP / action results             |
| `kernel/validation`    | shared Zod primitives, schema registry, pagination/filter contracts    |
| `kernel/events`        | domain event catalogue, outbox writer, dispatcher, delivery tracking   |
| `kernel/jobs`          | job queue, scheduler, retry/backoff, dead-letter, cron entrypoint      |
| `kernel/audit`         | append-only audit writer + query API                                   |
| `kernel/ratelimit`     | per-user / per-org / per-IP / per-route sliding window                 |
| `kernel/cache`         | request memoization + Redis with org-scoped keys and tag invalidation  |
| `kernel/config`        | typed env loading, feature flags, plan entitlements                    |
| `kernel/observability` | pino logger, request ids, Sentry, timing                               |
| `kernel/ui`            | design system primitives, DataTable, PageShell, states                 |

### C.2 Applications

1. **Command Center** — widget registry, layout persistence, alerts, AI insights
2. **CRM** — leads, contacts, companies, deals, pipelines, stages, activities, notes
3. **Projects** — projects, milestones, members, health scoring, templates
4. **Tasks** — kanban, dependencies, checklists, labels, comments, attachments
5. **People** — employees, teams, departments, skills, capacity, workload
6. **Finance** — invoices, items, payments, expenses, budgets, revenue, tax
7. **Documents** — folders, files, versions, permissions, preview, tags
8. **Communication** — comments, mentions, activity feeds, notifications, digests
9. **Workflow Automation** — visual builder, runs, approvals, templates
10. **AI Intelligence Center** — assistant, summaries, insights, generation
11. **AI Agents** — registry, tools, memory, runs, limits, cost metering
12. **Analytics** — metric engine, rollups, charts, filters, drill-downs
13. **Reporting** — templates, generation, scheduling, PDF/CSV export
14. **Global Search** — unified, permission-filtered, keyboard-first
15. **Administration** — org settings, members, roles, teams, departments
16. **Security Center** — sessions, login history, audit log, API keys, alerts
17. **Billing** — plans, entitlements, usage metering, Stripe integration
18. **Settings** — profile, organization, notifications, AI, security, billing
19. **Client Portal** — scoped external access (_v1.1, phase-gated_)

---

## D. Recommended tech stack (with reasons)

| Concern        | Choice                                                                    | Why this, not the alternative                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework      | **Next.js 15 App Router, React 19**                                       | RSC lets the read path call services directly — no API round-trip, no duplicated DTOs. Server Actions give a typed, CSRF-protected write path.                                                                                            |
| Language       | **TypeScript strict** + `noUncheckedIndexedAccess`                        | The tenancy/authz design leans on types (branded `OrgId`, `Ctx`, permission string unions).                                                                                                                                               |
| UI             | **Tailwind v4 + shadcn/ui + Radix + Lucide**                              | shadcn is copy-in, so the design system is _ours_ — required to give NEXUS a real identity instead of default-shadcn look. Radix supplies accessibility.                                                                                  |
| Database       | **PostgreSQL (Neon)**                                                     | DB branching per PR makes real integration tests cheap; serverless driver avoids connection exhaustion; RLS available as defense-in-depth.                                                                                                |
| ORM            | **Prisma 6** + `$extends`                                                 | The client extension is what makes tenant isolation _structural_ (auto-injected `orgId` filter) rather than something developers must remember. Drizzle was considered; Prisma wins on extensions + migrate for this shape.               |
| Pooling        | **Neon serverless driver / PgBouncer transaction mode**                   | Serverless + Postgres connection limits is the single most common production failure for this stack.                                                                                                                                      |
| Validation     | **Zod**                                                                   | One schema drives forms, action input, API contracts **and** AI tool parameters.                                                                                                                                                          |
| Forms          | **React Hook Form** + zod resolver                                        | Uncontrolled inputs keep dense data-entry screens fast.                                                                                                                                                                                   |
| Client data    | **TanStack Query v5**                                                     | Only where genuinely client-driven: kanban optimistic DnD, infinite tables, run polling. RSC covers everything else.                                                                                                                      |
| Auth           | **Auth.js v5 + Prisma adapter, database sessions**                        | We need multi-org membership, revocable sessions and a Security Center. A hosted identity vendor would own the org model — but the org model _is_ the product. Cost: we implement MFA and verification ourselves (accepted).              |
| Hashing        | **argon2id**                                                              | Memory-hard, current default.                                                                                                                                                                                                             |
| AI             | **Vercel AI SDK v5** as transport + **our own provider interface** on top | AI SDK handles streaming and tool-call plumbing; our interface keeps providers swappable and gives one seam for cost metering, redaction and audit. Default: `claude-opus-5` for agents, `claude-sonnet-5` for high-volume summarization. |
| Embeddings/RAG | **pgvector** in the same Postgres                                         | No extra service, per-org partitioning, sufficient to millions of rows.                                                                                                                                                                   |
| Jobs           | **DB-backed `Job` table + Vercel Cron**, behind `QueueAdapter`            | Transactional with the outbox, zero extra vendor for v1; swapping to Inngest/QStash later is an adapter change.                                                                                                                           |
| Cache / limits | **Upstash Redis**                                                         | Serverless-native; needed for distributed rate limiting regardless.                                                                                                                                                                       |
| Storage        | **S3-compatible (R2 or S3)**, private bucket, presigned URLs              | Files never served from the app origin; no public object URLs ever.                                                                                                                                                                       |
| Email          | **Resend + React Email**                                                  | Templates as components; good deliverability.                                                                                                                                                                                             |
| Payments       | **Stripe** Checkout + Billing Portal + webhooks                           | No card data touches us; entitlements derived from webhook-synced state.                                                                                                                                                                  |
| Charts         | **Recharts**                                                              | Composable and SSR-friendly; sufficient for the analytics surface.                                                                                                                                                                        |
| Tables         | **TanStack Table v8** (headless) behind one `DataTable` shell             | Server-side pagination/sort/filter with a single consistent UI.                                                                                                                                                                           |
| Drag & drop    | **dnd-kit**                                                               | Keyboard-accessible; react-beautiful-dnd is unmaintained.                                                                                                                                                                                 |
| PDF            | **@react-pdf/renderer** in a Node route handler                           | Deterministic; avoids headless Chrome on serverless.                                                                                                                                                                                      |
| Testing        | **Vitest** + **Playwright** + Neon branch per CI run                      |                                                                                                                                                                                                                                           |
| Telemetry      | **Sentry** + structured pino logs + request ids                           |                                                                                                                                                                                                                                           |
| Quality gates  | ESLint (+ `boundaries`), Prettier, knip, `tsc --noEmit`                   | Boundaries plugin mechanically enforces §B.2.                                                                                                                                                                                             |
| CI             | **GitHub Actions**                                                        | typecheck → lint → unit → integration (Neon branch) → e2e → build                                                                                                                                                                         |

**Repository shape decision:** a **single Next.js application with enforced internal module
boundaries** (`src/modules/*`), _not_ a Turborepo monorepo. One deployable, one tsconfig,
no package-publishing ceremony; boundaries enforced by lint rules instead of `package.json`
files. If a second deployable ever appears, extraction is mechanical because the module
boundaries already exist.
