# NEXUS OS — Final engineering report

Built by **Muhammad Kashif** — kashifarish2001@gmail.com

24 phases, a production-hardening pass (§25) and a completion pass (§26). Verified at the
point of writing: `npm run verify` green (**1,089 unit and integration tests** across 51
files), `npm run test:e2e` green (**54 Playwright journeys** across 6 specs against a
production build), `npm run build` green, `npm run check:bundle` inside budget.

**Status: ready for a first staging deployment; not production-ready.** §25.5 and §26.7 say
why, and §26.5 lists every external integration that has never been contacted.

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
19 migrations**, split by domain across `prisma/schema/` — `identity`, `organization`,
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
| End-to-end         | 53 Playwright journeys against a production build                                      |
| **Total**          | **1,087 unit and integration tests in 51 files; 53 E2E in 6 specs**                    |

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

**Not ready to be called production-grade**, and it would be dishonest to say otherwise. The
list below is as it stood before the hardening pass; **§25 records what changed.**

- ~~No error-reporting service.~~ **Addressed in §25** — a reporter now covers server, API and
  browser errors. It has never delivered an envelope to a live DSN.
- No alerting and no uptime monitoring. `/api/health` exists to be polled and `docs/RUNBOOK.md`
  §1 says exactly how to configure it — but nothing polls it and no alert rule exists anywhere.
  **This is configuration you must do.**
- No backup or restore drill. **The procedure is now written down** in `docs/RUNBOOK.md` §2 and
  marked DRILL REQUIRED. It has not been executed.
- The Anthropic and Stripe adapters have never been run against the live services. Unchanged,
  and now joined by the email and error-reporting adapters. See §25.3.
- No load testing beyond the query budgets. Unchanged.

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

> **Corrected during the hardening pass (§25).** This table previously listed
> `AUTH_SECRET` as required — it does not exist in the code and never did — and listed
> email, storage, cron and error reporting as _optional_. Three of those break the
> product on a serverless host and the fourth blinds you to it. All four fail silently.

**Required.** `npm run check:production` refuses a configuration missing any of these,
and says what breaks rather than only naming the variable:

| Variable                        | Purpose                               | Without it                                                            |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`                  | Pooled connection, runtime            | Every request fails.                                                  |
| `DIRECT_DATABASE_URL`           | Direct connection, migrations only    | `prisma migrate deploy` is unreliable through a pooler.               |
| `NEXT_PUBLIC_APP_URL`           | Absolute origin, https                | Every link in every email is wrong.                                   |
| `NEXT_PUBLIC_APP_NAME`          | Display name                          | Defaults to "NEXUS OS". Cosmetic.                                     |
| `EMAIL_PROVIDER` + `EMAIL_FROM` | A real transport: `smtp` or `resend`  | **Sign-up strands every user** — the verification link goes to a log. |
| `STORAGE_DRIVER=s3` + `S3_*`    | Object storage                        | **Uploaded documents vanish** on an ephemeral filesystem.             |
| `CRON_SECRET`                   | Shared secret for the scheduled sweep | **No notifications, no workflow resumption, no scheduled reports.**   |
| `SENTRY_DSN`                    | Error reporting                       | Errors reach stdout only. No alerting, no retention.                  |

`EMAIL_PROVIDER=smtp` additionally requires `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD`
(and `SMTP_PORT` / `SMTP_SECURE` if not 587/STARTTLS); `EMAIL_PROVIDER=resend` requires
`RESEND_API_KEY`. `STORAGE_DRIVER=s3` requires `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Each is validated at the point of use, and
selecting a transport without its credentials throws rather than falling back — a
deployment that believes it is sending email and is not is worse than one that knows it
cannot.

**Genuinely optional** — each enables a capability, and its absence is a state the
product is explicit about rather than a degradation it hides:

| Variable                                           | Without it                                                   |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`                                | The assistant says it is not configured. It invents nothing. |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`      | No checkout; an owner sets the plan, recorded as manual.     |
| `STRIPE_PRICE_TEAM` / `STRIPE_PRICE_BUSINESS`      | That plan cannot be purchased.                               |
| `AI_MONTHLY_BUDGET_MICROS`                         | Defaults to 50 USD per organization per month.               |
| `SENTRY_ENVIRONMENT` / `_RELEASE` / `_SERVER_NAME` | Reports are harder to group. Nothing breaks.                 |
| `STORAGE_MAX_UPLOAD_BYTES`                         | Defaults to 25 MB.                                           |

Two checks, answering two different questions:

- `npm run check:env` — does `.env.example` match the Zod schema? Runs in CI.
- `npm run check:production` — is _this_ configuration fit to serve real users? Reads
  configuration only: no connection, no request, no credentials needed.

**No secret is ever `NEXT_PUBLIC_`, and `.env.local` is gitignored and not committed** —
only `.env.example`, which contains placeholders and nothing else.

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
npm run check:production         # is THIS configuration fit to serve real users
npm test                         # 1,087 unit and integration tests
npm run verify                   # all of the above in one command
npm run build                    # production build
npm run test:e2e                 # 53 Playwright journeys against that build
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

> Revised in the hardening pass. Steps 3, 7 and 10 changed materially: three variables
> previously described as optional are required, and the preflight now proves it before a
> deploy rather than after.

1. **Provision PostgreSQL 17** (Neon, Supabase, or any managed Postgres). Take both connection
   strings: pooled and direct. Enable point-in-time recovery now, not later —
   `docs/RUNBOOK.md` §2.1 lists what to turn on per provider.

2. **Provision an S3-compatible bucket** (AWS S3, Cloudflare R2, MinIO). It must be **private**:
   this application never issues a public object URL. Enable versioning, so an overwrite or a
   delete is recoverable.

3. **Set environment variables** for Production and Preview — all eight required ones from §22.
   Then prove the configuration is fit before deploying anything:

   ```bash
   npm run check:production        # exit 0, or it tells you exactly what breaks
   ```

   Do not skip this on the grounds that the build succeeds. Every blocker it reports fails
   **silently** at runtime: the application starts, serves pages, accepts sign-ups, and does
   none of the things those users are waiting for.

4. **Import the repository** in Vercel. Framework preset: Next.js. No build command override.

5. **Run migrations** from your machine, against the direct URL:

   ```bash
   DIRECT_DATABASE_URL='postgresql://…' DATABASE_URL='postgresql://…' npm run db:deploy
   ```

6. **Seed the permission catalogue** — idempotent, and safe to re-run after every deploy that
   adds permissions. Skipping it means every page 403s:

   ```bash
   DATABASE_URL='postgresql://…' npm run db:seed
   ```

7. **Deploy**, then confirm all four:

   ```bash
   curl -s  https://<domain>/api/health            # {"status":"ok","checks":{"database":"ok"}}
   curl -sI https://<domain>/ | grep -i content-security-policy
   curl -sI https://<domain>/ | grep -i strict-transport-security
   curl -s  https://<domain>/robots.txt            # Disallow: /
   ```

8. **Confirm the cron job** under Settings → Cron Jobs. `vercel.json` registers
   `/api/cron/outbox` every five minutes, and the route accepts the GET that Vercel sends as
   well as a POST. Then confirm it actually ran: look for a `cron.outbox.completed` line in the
   function logs within ten minutes. **Registration is not evidence of execution** — a
   registered cron whose secret is wrong answers 404 forever and looks fine in the dashboard.

9. **If using Stripe**, add a webhook endpoint at `https://<domain>/api/webhooks/billing`,
   subscribe to `customer.subscription.*` and `invoice.payment_*`, and set
   `STRIPE_WEBHOOK_SECRET` to the signing secret. Send a test event and confirm a
   `BillingEvent` row appears with `processedAt` set. Until this is done, plans can only be set
   by hand, and a manual set is recorded as a manual decision with **no** paid period — so
   reconciliation can always tell "we saw a payment" from "somebody said so".

10. **Make one real call against every external integration** in a staging project before
    production. None has ever run against its live service (§25.3), and each is a place where
    the documented contract and the current API can have drifted:

    - **Email** — sign up as yourself and confirm the verification message arrives.
    - **Anthropic** — open the Intelligence Center and ask one question.
    - **Sentry** — throw a deliberate error and confirm the issue appears.
    - **Storage** — upload a document, then download it from a different session.

11. **Configure monitoring** — `docs/RUNBOOK.md` §1: an uptime monitor on `/api/health`, and the
    eight log-based alerts. The most important is the absence of `cron.outbox.completed`: a
    stalled schedule is invisible to an uptime check and stops notifications, workflow
    resumption and scheduled reports at once.

12. **Run the restore drill** — `docs/RUNBOOK.md` §2.5 — and write down how long it took.
    Until this is done the backup strategy is a hypothesis, and **the deployment is not
    finished.**

## 25. The production-hardening pass

Added after the report above was first written, and it changed several of its
conclusions. Where §20–§24 now disagree with an earlier statement, the later one is
correct and the change is described here.

### 25.1 What was fixed

**Two real defects in the Stripe webhook path.** Neither was covered by
idempotency-by-event-id, and both would have been silent — the subscription would simply
have held the wrong state, with nothing logged and nothing to notice:

1. **A failed webhook could never be retried successfully.** `claimEvent` refused any
   event id it had already seen, including one whose first attempt had thrown. The
   sequence was: attempt one claims the row, handling fails, the route answers 500 to ask
   for a retry — and every retry is then refused as "already processed" and answered 200.
   A transient database error during a subscription update meant that subscription never
   caught up. The claim now distinguishes _seen_ from _processed_: an unprocessed row is
   re-claimable through a conditional update, so exactly one of two concurrent retries
   proceeds.

2. **Out-of-order delivery could revive a cancelled subscription.** Webhooks are not
   ordered. A `customer.subscription.updated` retried after a timeout can arrive _after_
   the `customer.subscription.deleted` that followed it, and the older payload won.
   `Subscription.lastProviderEventAt` now records the provider timestamp of the newest
   applied event, and older state is recorded and refused. Idempotency does not cover
   this case: these are two different events, each processed exactly once, in the wrong
   order.

**A documentation defect that would have misled every deployment.** `AUTH_SECRET` was
listed as a required production variable in three places. No code in this repository
reads it, and none ever did — sessions are opaque 256-bit random tokens stored as SHA-256
digests, so there is no secret to sign with. Setting it would have done nothing while
creating the impression that something was protected by it. Removed from the
documentation rather than added to the code.

**Four "optional" variables that are not optional.** §22 previously listed email, cron,
storage and error reporting as capabilities you could leave off. On a serverless
deployment three of them break the product and the fourth blinds you to it — and each
fails _silently_. `npm run check:production` now refuses a configuration missing any of
them, with the consequence spelled out rather than the variable name alone.

**Everything else added:**

| Area             | Change                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error reporting  | A port with a Sentry envelope adapter over `fetch`. Server errors report through the logger, so all 18 existing call sites are covered without touching any of them. Browser errors post to `/api/telemetry/error` — the DSN never reaches the client, and the same redaction applies to both. |
| Email            | Two real transports: SMTP (STARTTLS mandatory, refusing to authenticate in the clear) and Resend. Header injection is stripped from subjects, which are partly derived from organization names.                                                                                                |
| Stripe transport | A 15-second timeout, and an `Idempotency-Key` on checkout creation so a double click cannot produce two sessions.                                                                                                                                                                              |
| AI transport     | Bounded retry on 429/5xx honouring `retry-after`, with full jitter; no retry on 4xx, which would only waste the user's time; and a timeout that reports itself in words rather than as `AbortError`. Retrying never outlives the caller's own deadline.                                        |
| Cron             | A Postgres advisory lock so invocations cannot pile up, and a `cron.outbox.completed` log line on every run — whose _absence_ is the only way to detect a stalled schedule.                                                                                                                    |
| Runbook          | `docs/RUNBOOK.md`: uptime-monitor configuration, eight log-based alert rules, the full restore procedure, and what the monitor will not catch.                                                                                                                                                 |

### 25.2 What was verified

- **The two Stripe fixes**, each by a test that fails without it: a retry after a forced
  failure now succeeds and records two attempts; a late `updated` event does not
  reactivate a cancelled subscription.
- **The AI transport**, against a stubbed `fetch`: retries on 429 and 529, does not retry
  on 400 or 401, gives up after three attempts, refuses a backoff that would outlive the
  request budget, and never echoes a key into an error message.
- **The SMTP dialogue**, against a scripted socket: the full STARTTLS → AUTH → DATA
  sequence, refusal to authenticate against a server with no STARTTLS, dot-stuffing, and
  rejection of a bad recipient rather than a false success.
- **Redaction**, on both paths: a password, an API key, a session token and a pay rate are
  all `[redacted]`; a nested object is described rather than serialised, so a request body
  cannot leave the process inside an error report.
- **The telemetry endpoint**, end to end: reachable without a session, discards malformed
  reports without describing the schema, refuses an oversized body, and is not reachable
  by GET.
- **Expand-only migrations**, mechanically: none of the 19 migrations contains a
  `DROP COLUMN`, `DROP TABLE`, `RENAME` or `SET NOT NULL`. This is what makes the restore
  procedure and a rollback viable.
- **The full gate**: typecheck, lint, format, env sync, 1,087 unit and integration tests,
  53 end-to-end journeys, production build, bundle budget.

### 25.3 What could NOT be verified — BLOCKED

No credentials for any external service were available, and none were invented. Each
integration below is written to its documented contract and tested against constructed
payloads; **the network path has never been exercised**, and the first real call will be
the first real call.

| Integration        | Blocked on                                   | What a first real call would prove                                                                                                                                     |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe**         | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | That the live event shape matches what `handleEvent` reads. One field worth watching: newer Stripe API versions moved `current_period_end` onto the subscription item. |
| **Anthropic**      | `ANTHROPIC_API_KEY`                          | That the Messages API request and response shapes are current.                                                                                                         |
| **SMTP**           | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`    | That real servers accept this dialogue. Servers differ in what they announce and tolerate.                                                                             |
| **Resend**         | `RESEND_API_KEY`                             | That the payload is accepted and the sending domain is verified.                                                                                                       |
| **Sentry**         | `SENTRY_DSN`                                 | That the envelope is accepted. Grouping will be by exception type and message rather than by stack frame — see the note in `reporting.ts`.                             |
| **Backup/restore** | A real database with real volume             | That the procedure in `docs/RUNBOOK.md` §2 works, and how long it takes.                                                                                               |
| **Vercel cron**    | A deployment                                 | That the schedule is registered and firing. Nothing in this repository can assert that.                                                                                |
| **Load**           | A load-testing target                        | Throughput under concurrency. Query _counts_ are pinned; timing is not.                                                                                                |

### 25.4 Remaining limitations, after this pass

Unchanged from §21 except where noted:

1. **No row-level security.** Deliberately not attempted in this pass: RLS with Prisma
   through a transaction-mode pooler requires per-transaction session variables, and
   adding that to 66 tables at the end of a hardening pass would risk the isolation that
   currently works and is proven. It remains the correct next structural investment.
2. **No MFA, OAuth or passkeys.** These are features, not hardening. Password-only with a
   30-day sliding session remains the largest authentication-side risk.
3. **No malware scanning.** Requires an external scanner; BLOCKED on infrastructure.
4. **No shared-store rate limiting.** Authentication throttling is database-backed and
   correct across instances. The telemetry limiter is in-memory and therefore
   per-instance — an accepted approximation, stated where it is implemented, on an
   endpoint that only writes telemetry.
5. **No cache layer and no rollups.** Unchanged.
6. **No load testing.** Unchanged.
7. **Sentry grouping is coarse.** Without the SDK there is no stack-frame parser and no
   source-map resolution, so issues group by exception type and message. The trade is
   documented in `reporting.ts`; switching to `@sentry/nextjs` is a contained change.
8. **SMTP is minimal.** No connection pooling, no DKIM signing, no attachments. If any of
   those become necessary, Nodemailer is the answer.
9. **Coverage.** Now 51 test files and 1,087 tests, up from 48 and 1,031.

### 25.5 Is it production-ready?

**No — and the gap is now configuration and rehearsal rather than code.**

What would make that a yes, in order:

1. Set the eight required variables (§22) — `npm run check:production` must exit 0.
2. Make one real call against each of Stripe, Anthropic and the email transport in a
   staging project, and confirm the shapes match.
3. Point an uptime monitor at `/api/health` and configure the eight log alerts in
   `docs/RUNBOOK.md` §1.4.
4. Perform the restore drill in `docs/RUNBOOK.md` §2.5 and write down the elapsed time.

Until step 4 is done, the honest claim is: **the application is ready to be deployed to a
staging environment and exercised.** It is not ready to hold data somebody would miss.

---

## 26. Completion and staging-readiness pass

The last pass before a first staging deployment. It found three more documentation defects of
the same class as `AUTH_SECRET`, one real correctness bug, and two gaps.

### 26.1 DONE

| Item                        | What changed                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creator attribution         | `Built by Muhammad Kashif` on the landing page footer, a new **Settings → About** screen with contact address, and the README. One constant (`src/lib/creator.ts`) so they cannot drift. |
| Stripe API-version handling | `current_period_end` is read from the subscription **and** from the subscription item, covering both sides of the `2025-03-31.basil` change. A test for each shape.                      |
| S3 request timeout          | The last external call without one. A hung request held a serverless invocation until the platform killed it.                                                                            |
| Skip link                   | A keyboard user previously tabbed through fourteen navigation items to reach content, on every navigation. Added, and covered by an end-to-end test.                                     |
| Environment-variable audit  | The authoritative list is **35 variables**, enumerated from the Zod schema. Every specified-but-never-built variable is now named as such in `docs/OPERATIONS.md` §P.4.                  |
| Deployment guide            | `docs/DEPLOYMENT.md` — a staging walkthrough where every step that can only be confirmed by running it is marked **CONFIRM**.                                                            |
| AI retrieval documentation  | `docs/AI-AND-AUTOMATION.md` now states that vector retrieval was never built, what replaced it, and what adding it would involve.                                                        |

### 26.2 Three more documentation defects

The same failure mode as `AUTH_SECRET` in §25: documentation describing variables and features
that do not exist, which a deployer would waste time on and — worse — might believe was
protecting something.

1. **`AI_PROVIDER` does not exist.** Nor does `OPENAI_API_KEY`, `AI_MODEL_*` or
   `AI_MONTHLY_TOKEN_BUDGET`. Anthropic is the only adapter and is selected by the presence of
   `ANTHROPIC_API_KEY` alone; model choice is a code table keyed by purpose
   (`src/lib/ai/router.ts`), deliberately not configuration. The budget variable that does
   exist is `AI_MONTHLY_BUDGET_MICROS`.
2. **Four of the six documented Stripe price variables do not exist**, and neither does
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — there is no Stripe script in the browser, because
   checkout is a redirect to a provider-hosted page.
3. **`UPSTASH_REDIS_*`, `FEATURE_*`, `ENCRYPTION_KEY`, `AUTH_URL`, `AUTH_GOOGLE_*` and
   `AUTH_GITHUB_*` do not exist.** No cache, no feature flags, nothing encrypted at rest, no
   OAuth.

### 26.3 The pgvector question, answered

The specification's context layer reads "Retrieval (SQL scopes + pgvector)". **Vector
retrieval was never built** — no extension, no embeddings table, no embedding is ever
computed, no similarity search exists. `EmbedRequest`/`EmbedResult` exist on the port and the
Anthropic adapter's `embed()` throws rather than returning a plausible zero vector.

What exists instead: **13 typed tools**, each calling a module query boundary that runs
`ctx.require()` before reading a row, plus a rolling window of the last 20 conversation turns.

This is worth being precise about in both directions. It is a **narrower capability** — the
assistant cannot answer by similarity, only through the filters the tools expose. It is also a
**stronger security position**, and not merely a consolation: with retrieval-by-embedding,
authorization is applied to chunks after the fact and a mis-scoped index leaks silently; with
retrieval-by-tool, the AI path is the same authorization path as the rest of the application,
so the isolation matrix already covers it.

Semantic retrieval is **FUTURE**, and adding it means pgvector, an embeddings table carrying
`organizationId`, a second provider (Anthropic has no embeddings endpoint), a backfill, and a
per-chunk permission re-check before anything reaches a prompt.

### 26.4 VERIFIED in this pass

Locally, without any external credential:

- Both Stripe `current_period_end` shapes, each by a test that fails without the fix.
- The S3 signing logic and timeout path; document upload, download, versions, sharing and
  quota through the existing integration suites.
- Tenant isolation across all 66 tenant models, and the 7 × 109 authorization matrix.
- The skip link, by keyboard, end to end.
- No secret is committed: the only tracked `.env*` file is `.env.example`, and it contains
  local placeholders only. The three secret-shaped strings in the repository are redaction
  test fixtures — including AWS's own published example key — and are meant to be there.
- **The full gate:** typecheck · lint · format · env sync · **1,089 unit and integration
  tests** · **54 end-to-end journeys** · production build · bundle budget (127.8 KB shared).

### 26.5 BLOCKED — requires credentials or a deployment

Unchanged from §25.3 and repeated because it is the part that matters:

| Integration          | Blocked on                                                                          |
| -------------------- | ----------------------------------------------------------------------------------- |
| Email delivery       | `RESEND_API_KEY`, or `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`                        |
| Document storage     | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Stripe               | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (test mode)                            |
| Anthropic            | `ANTHROPIC_API_KEY`                                                                 |
| Error reporting      | `SENTRY_DSN`                                                                        |
| Cron registration    | A Vercel deployment                                                                 |
| Backup/restore drill | A provisioned database with real volume                                             |

**No live call has been made to any of them.** Nothing in this repository claims otherwise.

### 26.6 FUTURE — deliberate, documented gaps

Not attempted, with the reason rather than an apology:

- **Row-level security.** The correct next structural investment. Requires per-transaction
  session variables through a transaction-mode pooler across 66 tables; adding it in a
  completion pass would risk isolation that currently works and is proven.
- **MFA, OAuth, passkeys.** Features, not hardening. Password-only with a 30-day sliding
  session remains the largest authentication-side risk.
- **Malware scanning on upload.** Needs an external scanner.
- **Cache layer, nightly rollups, load testing, shared-store rate limiting.**
- **Screen-reader audit.** Semantics, labels, focus order, landmarks and `aria-*` were built
  in deliberately and are exercised by role-based selectors throughout the E2E suite; the skip
  link was the one clear structural gap and is now fixed. **No assistive technology has been
  used against this application**, so it is unaudited rather than accessible.

### 26.7 Status

**Ready for a first staging deployment. Not production-ready**, and §25.5 still holds: the
remaining work is configuration and rehearsal, not code. The honest one-line summary is that
every line of this application has been tested against a real database and none of it has ever
spoken to a real external service.

---

### Where to read further

- `docs/ROADMAP.md` **§U** — every deviation from the specification, phase by phase, including
  each defect the tests found and what it turned out to be. 60 entries.
- `docs/OPERATIONS.md` **§Q** — deployment as built, and the explicit list of what is not there.
- `docs/DEPLOYMENT.md` — the step-by-step first staging deployment.
- `docs/RUNBOOK.md` — monitoring, alerting, backup and restore.
- `docs/PLATFORM.md` §H — the eight isolation layers in detail.
- `docs/AI-AND-AUTOMATION.md` §J — the agent authorization model.
