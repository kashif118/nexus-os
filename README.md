# NEXUS OS

An AI-powered **business operating system**: clients, projects, tasks, money, people and
documents in one multi-tenant platform, with a workflow engine and AI agents that work
through the same permissions a person does.

Not a CRM with extra screens, and not a dashboard. It is the system a company actually runs
on: an invoice raised in Finance is the row Analytics counts, the project Tasks belongs to,
and the record an agent is allowed to read only if you are.

---

## What it does

| Module                  | What it is                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRM**                 | Companies, contacts, leads, a drag-and-drop deal pipeline, activities and tags. Converting a lead creates the company, contact and deal in one transaction.            |
| **Projects**            | Members, milestones, budgets, health scoring, portfolio view. Visibility is per project, and a private project is invisible rather than forbidden.                     |
| **Tasks**               | A board with drag-and-drop, dependencies that actually block, checklists, comments, labels and time. A blocked task says what is blocking it.                          |
| **People**              | Profiles, teams, departments, skills, workload from real assignments. Pay data sits behind its own permission, denied even to most managers.                           |
| **Finance**             | Invoices, payments, expenses with approval, budgets. Integer minor units throughout — there is no floating-point arithmetic anywhere on a money path.                  |
| **Documents**           | Versioned files, folders, per-document sharing, attachment to any record, storage quota. A private document does not become public because a link leaked.              |
| **Notifications**       | In-app and email, driven by a transactional outbox so a notification cannot be sent for a change that rolled back.                                                     |
| **Workflows**           | Triggers, conditions, actions, approvals and delays, interpreted from a JSON graph. Runs are resumable and every step is recorded; a published version is immutable.   |
| **Intelligence Center** | An assistant over your own data, and generated insights. With no provider key configured it says so; it does not invent an answer.                                     |
| **AI agents**           | Five agents that propose and people who dispose. An agent's tools are an allowlist enforced at invocation, and it can never exceed the permissions of whoever runs it. |
| **Analytics**           | Metrics computed live from your records, with period comparison, series and drill-down.                                                                                |
| **Reports**             | Report definitions are parameters, not snapshots — reopening one recomputes it. CSV and printable export, with scheduling.                                             |
| **Security Center**     | Sessions, login history, an audit log, API keys, and organization security policy.                                                                                     |
| **Billing**             | Plans and entitlements, enforced on the server before the operation. Nothing marks a subscription paid except a signature-verified provider event.                     |

## The parts that were hard

- **Tenant isolation is structural.** Every tenant table carries a non-nullable
  `organizationId`, and a Prisma client extension injects it into every query — so forgetting
  a `where` clause returns your own rows rather than somebody else's. A client-supplied
  organization id that does not match the context throws rather than being silently rewritten.
  A generated matrix tests read, count, update and delete against all **66** tenant tables, and
  a schema-parsing test fails if a new tenant table is not registered.
- **Authorization is one function.** 109 permissions, 7 system roles, per-resource grants, and
  one rule that makes external access safe: a **denial beats any grant, including the owner's**.
  A generated matrix covers every role against every permission.
- **Money is integers.** Minor units as `bigint` with an ISO-4217 code, rates as basis points,
  totals computed only on the server from the line items. An invoice is paid because payments
  sum to it, not because a button was pressed.
- **Events are transactional.** Domain events are written in the same transaction as the change
  that caused them, then delivered with per-subscriber idempotency and retry.
- **AI is bounded by the same authorization as a person.** Agents call typed tools; tools call
  module query boundaries; those enforce the calling user's permissions. No agent holds a
  database handle, and a prompt cannot widen a permission.

## Getting started

**Requirements:** Node.js ≥ 20.11 and PostgreSQL 15+ (local or hosted).

```bash
# 1. Install dependencies
npm install

# npm 11 blocks package install scripts by default; approve the ones this project needs
npm approve-scripts prisma @prisma/engines esbuild unrs-resolver
npm rebuild prisma @prisma/engines esbuild unrs-resolver

# 2. Start a local PostgreSQL (no Docker or admin rights needed)
npm run db:start               # prints the DATABASE_URL to use

# 3. Configure the environment
cp .env.example .env.local     # then paste in the database URLs

# 4. Generate the client, create the schema, seed the permission catalogue
npm run db:generate
npm run db:deploy
npm run db:seed

# 5. Start the development server
npm run dev                    # http://localhost:3000
```

Then create an account at `/sign-up` and an organization. Email is printed to the server
console rather than sent unless a transport is configured, so the verification link is in
your terminal.

### Seeing it full rather than empty

```bash
npm run db:demo
```

Creates a demo organization — four people on four different roles, three clients, two
projects, ten tasks and four invoices in four different states — by calling the same
services the application calls. Nothing is inserted behind them, so the invoice totals are
computed by the finance service and the Command Center figures are figures the product
produced. It prints the sign-in details, refuses to run against a production database, and
refuses to run twice.

### Verifying the build

```bash
npm run verify        # typecheck · lint · format · env sync · 1,031 unit and integration tests
npm run test:e2e      # 49 Playwright journeys against a production build
npm run build         # production build
npm run check:bundle  # client bundle budget, gzipped
```

`npm run db:start` runs a real PostgreSQL from a prebuilt binary into `.postgres-data/`, so
integration tests run against genuine Postgres semantics rather than a mock. CI uses a
service container instead.

## Architecture in one screen

```
app/            UI — React Server Components + client islands
  ↓
modules/<m>/actions|queries    transport: Zod validation, permission check, rate limit
  ↓
modules/<m>/service            business rules, authorization, transactions, domain events
  ↓
modules/<m>/repository         Prisma access only
  ↓
lib/db                         org-scoped Prisma client
```

Enforced by `eslint-plugin-boundaries`, not by convention: the UI cannot import a repository,
a service cannot import the database client, and an AI tool can only reach data through a
module boundary that checks permissions. `npm run lint` is where you see it work.

**Stack:** Next.js 16 (App Router, Server Actions) · React 19 · TypeScript 5.9 strict with
`noUncheckedIndexedAccess` · Tailwind CSS v4 · PostgreSQL + Prisma 7 (driver adapters) ·
Zod 4 · Vitest · Playwright · ESLint · Prettier. No state-management library, no data-fetching
library, no ORM escape hatches, and no AI SDK — the Anthropic adapter is a `fetch` call behind
a port, so swapping providers is one file.

## Documentation

| Document                                                     | Contents                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)             | Product, system and module architecture; stack decisions      |
| [`docs/DATA-MODEL.md`](./docs/DATA-MODEL.md)                 | Entity map, indexes, cascades, tenant isolation               |
| [`docs/PLATFORM.md`](./docs/PLATFORM.md)                     | Folder structure, authentication, multi-tenancy, RBAC         |
| [`docs/AI-AND-AUTOMATION.md`](./docs/AI-AND-AUTOMATION.md)   | AI provider abstraction, agent runtime, workflow engine       |
| [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)                 | API contracts, security, testing, **§Q deployment as built**  |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md)                       | Phases, risks, decision log, **§U every deviation from spec** |
| [`docs/ENGINEERING-REPORT.md`](./docs/ENGINEERING-REPORT.md) | The final report: every module, the numbers, and the limits   |

`docs/ROADMAP.md` §U is worth reading on its own: it records every place the built system
departs from the specification and why, including the defects the tests found.

## Deploying

`docs/OPERATIONS.md` §Q has the exact steps, the required environment variables, and what each
optional one turns on. The short version: provision Postgres, set `DATABASE_URL`,
`DIRECT_DATABASE_URL`, `AUTH_SECRET` and `NEXT_PUBLIC_APP_URL`, run `npm run db:deploy` and
`npm run db:seed`, deploy, and check `GET /api/health`.

## What this is not

Stated plainly, because the difference between "planned" and "present" is where trust is lost.

- **No error-reporting service, alerting, or uptime monitoring.** `/api/health` exists to be
  polled; nothing polls it.
- **No cache layer and no nightly rollups.** Everything is computed per request, which the
  query-budget tests keep affordable and which will need revisiting long before a tenant has
  millions of rows.
- **No Postgres row-level security.** Isolation is enforced by the scoped client and proven by
  the matrix; RLS is the defence-in-depth layer that is not there.
- **No malware scanning on upload.** Documents record a `SKIPPED` scan status rather than
  claiming a clean one.
- **The Anthropic and Stripe adapters have never been run against the live services.** They are
  written to the documented contracts and tested against fixtures.
- **Unit and integration coverage is 50% of statements** across `kernel`, `lib` and `modules`.
  UI is covered by the end-to-end suite instead, which Vitest does not instrument.

## License

Not yet licensed. All rights reserved.
