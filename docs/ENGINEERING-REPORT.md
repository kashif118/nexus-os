# NEXUS OS — Final engineering report

24 phases, 25 commits, 363 source files, ~58,600 lines of TypeScript. Verified at the point
of writing: `npm run verify` green (1,031 unit and integration tests across 48 files),
`npm run test:e2e` green (49 Playwright journeys across 6 specs against a production build),
`npm run build` green, `npm run check:bundle` inside budget.

Where this report states a number, it was measured. Where something is missing, it says so.

---

## 1. All modules

Sixteen module folders under `src/modules/`, each with the same internal shape —
`actions.ts` / `queries.ts` (transport), `service.ts` (rules and authorization),
`repository.ts` (Prisma only), `schema.ts` (Zod), `components/`.

| Module          | Ships                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| `auth`          | Registration, sign-in, email verification, password reset, throttling, account overview |
| `organizations` | Creation, settings, members, invitations, role assignment, org switching                |
| `crm`           | Companies, contacts, leads, pipelines, deals, activities, tags, lead conversion         |
| `projects`      | Projects, members, milestones, budgets, derived health, portfolio                       |
| `tasks`         | Board, dependencies, checklists, comments, labels, assignment, time                     |
| `people`        | Profiles, teams, departments, skills, workload                                          |
| `finance`       | Invoices, payments, expenses with approval, budgets, summaries                          |
| `documents`     | Upload, versions, folders, sharing, attachments, storage quota                          |
| `notifications` | In-app and email delivery, preferences, digest, outbox drain                            |
| `workflows`     | Visual builder, engine, triggers, conditions, approvals, delays, runs                   |
| `ai`            | Provider port, gateway, Intelligence Center, insights, 13 tools, 5 agents               |
| `analytics`     | 11 metrics, period comparison, series, drill-down                                       |
| `reports`       | 4 templates, parameters, CSV and printable export, scheduling                           |
| `security`      | Sessions, login history, audit log, API keys, security policy                           |
| `billing`       | Plans, entitlements, checkout, portal, webhooks, usage                                  |
| `dashboard`     | The Command Center as a widget registry — 17 widgets contributed by other modules       |

60 pages and 8 API routes. Adding a module touches no existing module: it registers its own
widgets, its own workflow actions and its own AI tools.

## 2. Database architecture

PostgreSQL with Prisma 7 using driver adapters (`@prisma/adapter-pg`). **77 models, 46 enums,
18 migrations**, split by domain across `prisma/schema/` — `identity`, `organization`,
`authorization`, `crm`, `projects`, `tasks`, `people`, `finance`, `documents`, `events`,
`workflows`, `ai`, `agents`, `analytics`, `reports`, `security`, `billing`, `base`.

Design decisions that matter:

- **66 of the 77 models carry a non-nullable `organizationId`.** The exceptions are global by
  design: `User`, `Session`, `VerificationToken`, `LoginEvent`, `Organization` itself, and the
  system role/permission templates. `AuditLog` is deliberately nullable — a sign-up belongs to
  no organization — and is scoped explicitly at its call sites instead.
- **Soft deletion where history matters** (`deletedAt`), hard deletion where it does not.
- **Money is never a float.** `BigInt` minor units with an ISO-4217 `Char(3)` currency, rates as
  integer basis points, quantities as integers scaled by 1,000.
- **Every list filter is indexed.** A test reads `pg_index` and fails if any tenant table lacks
  an index whose _first_ column is `organizationId`, or if one of the seven hottest list filters
  lacks a composite index whose leading columns are exactly the columns it filters on.
- **Compound uniqueness is org-scoped**: `@@unique([organizationId, number])` on invoices,
  `@@unique([organizationId, key])` on projects, and so on — so two tenants can both have
  `INV-0001`.

## 3. Authentication

Email and password with server-side sessions. Auth.js was specified and rejected; the reasoning
is in `docs/ROADMAP.md` §U9.

| Property         | Implementation                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Password hashing | argon2id, 19 MiB / t=2 / p=1, via `@node-rs/argon2`                                      |
| Session token    | 256 bits of randomness in an httpOnly, SameSite=Lax, `__Host-` prefixed cookie           |
| Token storage    | SHA-256 digest only — a database leak yields nothing replayable                          |
| Lifetime         | 30 days, sliding, refreshed at most hourly; revocable individually from the account page |
| Route protection | `requireUserPage()` in the server layout. The edge proxy only redirects early            |
| Throttling       | 5 failures per email and 20 per IP in 15 minutes, counted from `LoginEvent` rows         |
| Enumeration      | Sign-in and password reset answer identically for known and unknown addresses            |
| Reset tokens     | Single-use, 30-minute TTL; using one revokes every session                               |

**Not built:** OAuth providers, MFA/TOTP, passkeys. The schema has room for them; no code
pretends they exist.

## 4. Multi-tenancy

Isolation is structural rather than remembered. Eight layers, of which the decisive one is the
fourth:

1. The edge proxy redirects an obviously signed-out visitor — a convenience, not a control.
2. `requireCtxPage(orgSlug)` in the organization layout resolves the slug to an **ACTIVE
   membership for the signed-in user**, and answers **404** for a non-member. Not 403: a 403
   confirms the organization exists.
3. Every service takes a `Ctx` carrying `orgId`, `membershipId` and resolved permissions.
4. **`getDb(orgId)` returns a Prisma client extension that injects `organizationId` into every
   query against a tenant model.** Forgetting a `where` clause returns your own rows.
5. A caller-supplied `organizationId` that does not match the context throws
   `CrossTenantAccessError` — it is _not_ silently rewritten, because silently rewriting turns
   an attempted attack into a successful-looking request.
6. `findUnique` is rewritten to `findFirst` so an id belonging to another tenant returns null
   rather than that tenant's row.
7. `TENANT_MODELS` completeness is enforced by a test that parses `prisma/schema/*.prisma`.
8. A generated isolation matrix exercises read, count, update and delete against **all 66**
   tenant models.

`getSystemDb()` is the unscoped escape hatch, restricted by lint to authentication,
organization creation, invitation acceptance, webhooks and cron, and conspicuous where used.

**Not built:** Postgres row-level security. It is defence in depth on top of the above, not a
replacement for it, and its absence is recorded in `docs/OPERATIONS.md` §Q.2.

## 5. RBAC

**109 permissions** in a code catalogue (`src/kernel/authz/catalogue.ts`), from which the
`Permission` union type is derived — a typo is a compile error. **7 system roles**: Owner,
Admin, Manager, Finance Manager, HR Manager, Employee, Client. Custom roles per organization,
plus per-resource grants (`ResourcePolicy`).

The rule that makes the whole thing safe to hand an external party: **a denial beats any grant,
including the owner short-circuit.** The Client role denies twelve permissions explicitly, so a
future edit that widens a grant cannot accidentally expose finance or people data to a customer.

`resolveScope(any, own)` collapses the common "all or only mine" pair into one call, so a
repository filter cannot drift from the permission that authorised it.

A generated matrix (`authorization-matrix.test.ts`, 53 assertions) covers all 7 roles against
all 109 permissions and asserts: every granted permission exists in the catalogue, the owner has
everything not explicitly denied, Admin ⊇ Manager ⊇ Employee with no exceptions, and DENY beats
ALLOW even for an owner.

**UI checks are separate from server checks.** `ctx.can()` in a component decides what to
render; `ctx.require()` in a service decides what happens. Hiding a button is not authorization.

## 6. CRM

Companies, contacts, leads, pipelines with ordered stages, deals, activities and tags.

- **Lead conversion is one transaction**: company, contact and (optionally) deal created
  together, the lead marked converted, and the trail kept — so a partial conversion cannot exist.
- **The pipeline board** moves deals between stages with an optimistic client update and a
  server-side reorder, recording `DealStageHistory` so cycle time is derivable rather than
  guessed.
- Won/lost is an outcome with a reason, not a stage you can drag into by accident.
- Deal values are minor units, and the pipeline total is summed by the database.

## 7. Projects

Projects carry members, milestones, a budget, a manager, and a visibility (`ORGANIZATION` /
`PRIVATE`). A private project is **invisible** to a non-member rather than forbidden.

**Health is derived, never stored.** A score computed from schedule slip, milestone completion,
overdue tasks and budget consumption, in one pure function (`health.ts`) with its own tests. A
stored health field would go stale the moment anything else changed.

The portfolio view aggregates across projects the caller can see — which is the point of
`resolveScope`: the summary and the list agree because they share one filter.

## 8. Tasks

A Kanban board with drag-and-drop, plus a table view. Dependencies, checklists, comments,
labels, assignment, estimates and spent time.

- **Dependencies actually block.** Moving a task to `IN_PROGRESS` with an incomplete prerequisite
  is refused by the service, and the detail page says _which_ task is blocking it before you try.
  The cycle check is a graph traversal with its own unit tests.
- **Task numbers are allocated atomically** by a raw `UPDATE … RETURNING`, because read-then-write
  gives two concurrent creates the same number under any real load.
- Board ordering uses a fractional rank (`Decimal`), so inserting between two cards is one row
  update rather than renumbering a column.

## 9. People

Profiles, teams, departments, skills with proficiency, and a workload view computed from real
task assignments and estimates.

**Sensitive fields are a separate permission.** `people.profile.read.sensitive` gates pay rates
and compensation, and is held by HR Manager and Owner — explicitly _not_ by Manager or Finance
Manager. The authorization matrix asserts that.

## 10. Finance

Invoices, payments, expenses with an approval flow, and budgets.

- **Integer minor units end to end.** `BigInt` throughout; the line-item arithmetic
  (`calculate.ts`) is pure, exhaustively unit-tested, and shared by the server and the live
  preview in the editor — so the total on screen before saving is the total that gets stored.
- **Totals are computed server-side from the items.** A client cannot post a total.
- **Status is derived, not set.** An invoice is `PAID` because its payments sum to its total, and
  `OVERDUE` because its due date has passed with a balance outstanding. There is no button that
  marks something paid.
- Discounts and tax are basis points. Quantities are integers scaled by 1,000.
- Expenses route through submit → approve/reject with the approver recorded.

## 11. Documents

Versioned files with folders, per-document sharing, attachment to any record, and a storage
quota enforced before the bytes are written.

- **Visibility is checked on the download route, not only in the list.** A private document
  answers 404 to a non-grantee even with the exact id.
- Downloads set `Content-Disposition: attachment` and `Content-Security-Policy: default-src
'none'; sandbox`, so an uploaded HTML file cannot execute against the app's origin.
- Two storage drivers behind one port: local filesystem for development, S3-compatible for
  deployment. The local driver is unsuitable on serverless, and the deployment notes say so.
- File names are sanitised by an explicit codepoint filter, not a regex.

**Not built:** malware scanning. Documents record a scan status of `SKIPPED` rather than a
fabricated clean result.

## 12. Notifications

In-app and email, with per-type preferences and a digest option.

The important part is the delivery mechanism: a **transactional outbox**. `emitEvent(input, tx)`
writes the event in the _same transaction_ as the change that caused it, so a notification can
never be sent for a change that rolled back, and a change can never fail to notify because the
mailer was down.

`drainOutbox()` delivers to subscribers independently, with per-subscriber `OutboxDelivery`
idempotency and `MAX_ATTEMPTS = 5`. Draining happens after the request via `after()`, with the
cron endpoint as the safety net for a process that died mid-drain.

## 13. Workflow engine

A JSON graph, interpreted — not generated code, not `eval`.

- **Node kinds:** trigger, condition, action, approval, delay, branch.
- **8 triggers** (task assigned, expense submitted, invoice overdue, invoice paid, deal won, and
  others), each declaring the fields it exposes.
- **Built-in actions:** send notification, create task, log activity, send email.
- **Conditions are interpreted over a flat, allowlisted field map** — `Object.hasOwn`, not `in`,
  so a prototype key cannot be read. There is no expression language to escape from.
- **A published `WorkflowVersion` is immutable.** Editing produces a new version; a run in flight
  finishes on the version it started on.
- **Steps are idempotent** via a `(runId, nodeId)` unique constraint, so a retried drain cannot
  double-execute an action.
- **Approvals and delays suspend and resume.** A run waiting on either has nothing to wake it but
  the scheduler, which is why the cron endpoint matters.
- A depth cap and per-org run quota stop a workflow that triggers itself.

## 14. AI Intelligence Center

An assistant over the organization's own data, plus generated insights.

- **Own message and tool types**, with a `LanguageModelProvider` port. The Anthropic adapter is a
  `fetch` call — no vendor SDK — so a second provider is one file.
- **A gateway** that checks the budget _before_ the call, redacts, meters into an append-only
  `AIExecution` row, and truncates context.
- **Redaction is a shared definition.** The same field list that keeps a pay rate out of a prompt
  keeps it out of a log line.
- **Untrusted content is delimited and labelled** before it reaches the model, and tools are
  authorized independently of what the model asked for — so a prompt injected into a client's
  note cannot widen a permission.

**With no `ANTHROPIC_API_KEY` configured the assistant says it is not configured.** It does not
produce a canned answer that looks like a real one.

## 15. AI agents

**Five agents**: Project Health, Receivables, Pipeline, Workload, Daily Briefing. Each maps to
an existing permission in the catalogue.

The governing design is **propose, then dispose**:

- An agent's output is an `AIProposal` row. Nothing happens until a person accepts it, and
  accepting executes with the **accepting person's** permissions, not the agent owner's.
- **The tool allowlist is enforced at invocation**, not only in what is offered to the model. A
  test asserts that an agent naming a tool outside its list creates nothing — this was a real bug
  the test found (§U39).
- **13 tools**, all calling module query boundaries. No agent holds a database handle.
- **System prompts are code.** An organization may _append_ instructions, never replace them, and
  appended text cannot widen the allowlist or the permission ceiling — an editable system prompt
  is an editable security boundary.
- `AUTONOMOUS` mode exists, is opt-in per agent, and requires `ai.settings.manage`.

## 16. Analytics

**11 metrics** in a registry, computed live from the organization's own rows: revenue received,
invoiced, expenses, tasks completed, tasks overdue, active projects, at-risk projects, deals won,
pipeline value, win rate, active members.

- Period comparison against the equivalent preceding window; series for the metrics that have
  one; drill-down links to the list that produced the number.
- **All boundaries are UTC**, stated in the UI — the alternative, per-organization time zones,
  means two people comparing screens get different numbers for the same question.
- The page renders its shell and period selector before any query runs and streams the metrics in
  behind Suspense. It issues 29 queries, in parallel, each indexed, and the count is pinned by a
  test so "one more metric" cannot quietly become forty.

**Not built:** nightly rollups. `MetricSnapshot` exists in the schema; nothing writes to it on a
schedule.

## 17. Reporting

**4 templates**: executive summary, receivables ageing, project status, team workload.

**A report is parameters, not a snapshot.** Reopening one recomputes it from current data, which
is the difference between a report and a screenshot. Export to CSV and to a printable HTML view.
Scheduled reports run from the cron endpoint under a membership context.

## 18. Security

The Security Center: sessions, login history, an audit log, API keys, and organization security
policy (session lifetime, IP allowlist, new-IP alerting).

- **API keys**: 256 bits of entropy, stored only as a SHA-256 digest, plaintext returned exactly
  once. No KDF, deliberately — Argon2 protects a low-entropy secret against guessing, and a
  256-bit random token cannot be guessed. A key's context is built from its **creator**, with
  permissions intersected against the key's scopes, so a key is never more powerful than the
  person who made it, at creation _or_ afterwards. A key in a query string is not read at all.
- **The audit log is append-only** and gated on `security.loginhistory.view` rather than plain
  membership — "who did what" is exactly what an attacker inside an organization wants.
- **Ending your own session needs no permission; ending somebody else's does.** And neither can
  reach a session belonging to another organization.
- **Headers**: nonce-based CSP with `strict-dynamic` and no `'unsafe-inline'` on scripts,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS
  in production. An E2E test drives a real journey and fails on any browser-reported violation.
- **Billing cannot be faked.** Starting a checkout changes nothing; the success redirect changes
  nothing. Only a signature-verified webhook moves a subscription, and processing is idempotent
  by the provider's event id.

## 19. Testing

| Layer              | Count                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- |
| Unit               | Pure logic: money, dependency graphs, conditions, health, periods, key handling        |
| Integration        | Against real PostgreSQL, per module                                                    |
| Generated matrices | Authorization (7 × 109), tenant isolation (66 models), index coverage, tenant registry |
| Query budgets      | Every list screen at 5 rows and at 200, requiring an identical query count             |
| End-to-end         | 49 Playwright journeys against a production build                                      |
| **Total**          | **1,031 unit and integration tests in 48 files; 49 E2E in 6 specs**                    |

Coverage is **50% of statements** across `kernel`, `lib` and `modules`. That figure includes
Server Actions, which Vitest does not instrument and which the E2E suite covers instead; React
components are excluded with the reason recorded in `vitest.config.mts`. It is reported rather
than improved by narrowing what it counts.

**The tests found real defects**, which is the argument for having written them this way rather
than as confirmations: the proxy returning HTML to API callers, the agent tool allowlist not
being enforced at invocation, a step-position race inside `Promise.all`, a development database
created in WIN1252, a silently-ignored Vitest option that left the suite fully parallel, two
notification tests passing vacuously, six create forms that invited duplicate records, and — from
writing the deployment notes — a proxy rule that would have made every Stripe webhook and every
cron run fail in production.

## 20. Deployment readiness

**Ready:** the application builds, all gates are green, the security headers and CSP are real and
tested, `/api/health` answers, the cron endpoint is scheduled in `vercel.json` and accepts both
the GET Vercel sends and a POST, logging is structured, and `docs/OPERATIONS.md` §Q has the exact
steps.

**Not ready to be called production-grade**, and it would be dishonest to say otherwise:

- No error-reporting service. Errors reach `stdout`.
- No alerting, no uptime monitoring, no dashboards. `/api/health` exists to be polled; nothing
  polls it.
- No backup or restore drill. PITR is a property of the database provider, and it has not been
  exercised here.
- The Anthropic and Stripe adapters have never been run against the live services.
- No load testing beyond the query budgets.

A reasonable next step is one week: error reporting, an uptime check, a restore drill, and a
first live call against each provider in a staging project.

## 21. Remaining limitations

1. **No row-level security.** Isolation is enforced by the scoped client and proven by the
   matrix. RLS is the layer that would survive a bug in that client.
2. **No caching.** Every figure is computed per request. The Command Center is 18 queries and
   analytics is 29 — fine now, and the first thing to revisit at scale.
3. **No nightly rollups.** Analytics computes live over the full history.
4. **No malware scanning** on document upload.
5. **No OAuth, MFA or passkeys.**
6. **No real-time.** No WebSocket or SSE; the notification bell polls.
7. **IPv6 is not supported in the IP allowlist** — the CIDR validator refuses what the matcher
   cannot enforce, rather than accepting it and quietly not enforcing it.
8. **Email is single-transport.** Without SMTP configured it prints to the server log.
9. **The local storage driver is unsuitable on serverless**; S3 credentials are required for a
   real deployment.
10. **Coverage is 50%.** The untested half is overwhelmingly transport and UI, but it is
    untested.
11. **No internationalisation.** English, UTC, and `en` number formatting.
12. **Accessibility has not been audited** with a screen reader. Semantics, labels, focus order
    and `aria-*` were built in deliberately and are exercised by role-based E2E selectors, but
    that is not the same as an audit.

## 22. Required production environment variables

Required — the application will not work without them:

| Variable               | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`         | Pooled connection used at runtime (PgBouncer / Neon pooler)             |
| `DIRECT_DATABASE_URL`  | Direct connection, migrations only — DDL through a pooler is unreliable |
| `AUTH_SECRET`          | 32+ random bytes                                                        |
| `NEXT_PUBLIC_APP_URL`  | Absolute origin, used for email links and `metadataBase`                |
| `NEXT_PUBLIC_APP_NAME` | Display name                                                            |

Optional — each turns a capability on rather than changing an existing one:

| Variable                                      | Without it                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `CRON_SECRET`                                 | `/api/cron/outbox` answers 503; no drains, workflow resumption or reports |
| `AI_PROVIDER` + `ANTHROPIC_API_KEY`           | The assistant says it is not configured                                   |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | No checkout; plans set manually and recorded as manual                    |
| `STORAGE_DRIVER=s3` + S3 credentials          | Local filesystem storage, unsuitable on serverless                        |
| SMTP / email transport settings               | Email printed to the server log rather than sent                          |

`npm run check:env` diffs `.env.example` against the Zod schema and runs in CI, so the two
cannot drift. **No secret is ever `NEXT_PUBLIC_`, and `.env.local` is not committed.**

## 23. Running it locally — exact commands

```bash
# Install, approving the install scripts npm 11 blocks by default
npm install
npm approve-scripts prisma @prisma/engines esbuild unrs-resolver
npm rebuild prisma @prisma/engines esbuild unrs-resolver

# A real PostgreSQL, no Docker and no admin rights
npm run db:start                 # prints the DATABASE_URL to use

# Configure
cp .env.example .env.local       # paste in the two database URLs

# Schema and permission catalogue
npm run db:generate
npm run db:deploy
npm run db:seed

# Optional: a populated organization to look at
npm run db:demo                  # prints sign-in details

# Run
npm run dev                      # http://localhost:3000
```

Verification:

```bash
npm run typecheck                # tsc --noEmit
npm run lint                     # ESLint, including architectural boundary rules
npm run format:check             # Prettier
npm run check:env                # .env.example matches the schema
npm test                         # 1,031 unit and integration tests
npm run verify                   # all of the above in one command
npm run build                    # production build
npm run test:e2e                 # 49 Playwright journeys against that build
npm run check:bundle             # client bundle budget, gzipped
```

Database:

```bash
npm run db:start / db:stop       # local PostgreSQL on port 55432
npm run db:validate              # validate the schema
npm run db:migrate               # create and apply a migration (development)
npm run db:deploy                # apply migrations (CI / production)
npm run db:studio                # browse data
```

## 24. Deploying to Vercel — exact steps

1. **Provision PostgreSQL 17** (Neon, Supabase, or any managed Postgres). Take both connection
   strings: pooled and direct.

2. **Import the repository** in Vercel. Framework preset: Next.js. No build command override.

3. **Set environment variables** for Production and Preview — the five required ones from §22, and
   whichever optional ones you want active. The build fails at boot if a required one is missing,
   which is intended.

4. **Run migrations** from your machine, against the direct URL:

   ```bash
   DIRECT_DATABASE_URL='postgresql://…' DATABASE_URL='postgresql://…' npm run db:deploy
   ```

5. **Seed the permission catalogue** — idempotent, and safe to re-run after every deploy that adds
   permissions:

   ```bash
   DATABASE_URL='postgresql://…' npm run db:seed
   ```

6. **Deploy**, then confirm:

   ```bash
   curl -s https://<domain>/api/health     # {"status":"ok","checks":{"database":"ok"}}
   curl -sI https://<domain>/ | grep -i content-security-policy
   ```

7. **Confirm the cron job** under Settings → Cron Jobs. `vercel.json` registers
   `/api/cron/outbox` every five minutes. Without `CRON_SECRET` set it answers 503 and no
   scheduled work happens — no outbox drains, no workflow resumption, no scheduled reports.

8. **If using Stripe**, add a webhook endpoint at `https://<domain>/api/webhooks/billing`,
   subscribe to `customer.subscription.*` and `invoice.payment_*`, and set
   `STRIPE_WEBHOOK_SECRET` to the signing secret. Verify with a test event that the
   `StripeEvent` idempotency row appears. Until this is done, plans can only be set by hand, and
   a manual set is recorded as a manual decision with **no** paid period — so reconciliation can
   always tell "we saw a payment" from "somebody said so".

9. **Before inviting anyone real**: add an error-reporting service, point an uptime monitor at
   `/api/health`, and run a restore drill. None of the three is in this repository, and the
   deployment is not finished without them.

---

### Where to read further

- `docs/ROADMAP.md` **§U** — every deviation from the specification, phase by phase, including
  each defect the tests found and what it turned out to be. 60 entries.
- `docs/OPERATIONS.md` **§Q** — deployment as built, and the explicit list of what is not there.
- `docs/PLATFORM.md` §H — the eight isolation layers in detail.
- `docs/AI-AND-AUTOMATION.md` §J — the agent authorization model.
