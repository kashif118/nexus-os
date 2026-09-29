# NEXUS OS — M. API · N. Security · O. Testing · P. Deployment · Env vars

---

## M. API architecture

### M.1 Four transports, chosen by purpose

| Transport                     | Used for                                                               | Why                                                            |
| ----------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| **RSC queries**               | all first-party reads                                                  | no HTTP hop, no duplicate DTOs, no client-side over-fetch      |
| **Server Actions**            | all first-party writes                                                 | typed end-to-end, CSRF-protected, progressive enhancement      |
| **Route Handlers**            | streaming AI, file upload/download signing, webhooks, cron, public API | needs raw Request/Response, non-form clients, or non-user auth |
| **Public REST API `/api/v1`** | integrations                                                           | API-key auth, versioned, documented with OpenAPI               |

TanStack Query sits on top of _actions_ (not a separate REST layer) for the few
client-driven surfaces — kanban, infinite tables, run polling.

### M.2 The single command wrapper

Every write goes through one factory so no handler can forget a step:

```ts
export const updateProject = createAction({
  input: updateProjectSchema, // Zod
  permission: 'project.update.any', // checked against Ctx
  rateLimit: { key: 'project.update', limit: 60, window: '1m' },
  audit: { action: 'project.updated', entityType: 'Project' },
  handler: async (ctx, input) => projectService.update(ctx, input),
})
```

The wrapper does, in order: rate limit → parse input (typed field errors on failure) →
`requireCtx()` → permission check → entitlement check → run handler in a request-scoped
logger + Sentry scope → map thrown `AppError` to a typed result → write audit → revalidate
cache tags. Handlers never touch `try/catch` for control flow.

**Uniform result contract** (never throws to the client):

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; fields?: Record<string, string[]> } }
```

### M.3 Read contract

```ts
listProjects(ctx, {
  page, pageSize (≤100), sort: { field, dir },
  filters: { status?, priority?, managerId?, companyId?, q?, dueBefore? },
}) → { items: ProjectListItem[], total, page, pageSize, hasMore }
```

Rules: server-side pagination/sorting/filtering only (no "fetch all then filter");
cursor pagination for feeds and activity; whitelisted sort fields (no arbitrary column
names into the ORM); list DTOs are narrow — detail data is only in detail queries.

### M.4 API surface by domain

```
auth          sign-in · sign-up · verify · reset · mfa · sessions
organizations create · update · members · invitations · roles · teams · departments · settings
projects      CRUD · members · milestones · health · templates
tasks         CRUD · board move · dependencies · checklists · comments · attachments
crm           leads · contacts · companies · deals · pipelines · stages · activities · convert
finance       invoices · items · send · approve · void · payments · expenses · budgets
documents     upload-url · commit · download-url · folders · versions · permissions
communication comments · mentions · notifications · preferences · feed
workflows     CRUD · publish · runs · run detail · test-run · approvals
ai            chat (stream) · agents · conversations · insights · tools registry · usage
analytics     metrics · series · breakdowns · export
reports       generate · schedule · list · download
search        global · scoped
admin         audit · sessions · login history · api keys · security alerts
billing       plans · checkout session · portal session · subscription · usage
```

### M.5 Public API `/api/v1`

Bearer `nx_live_…` API keys (prefix stored, key hashed), scoped per key, org-bound, rate
limited per key. Versioned URL, `RFC 7807` problem+json errors, cursor pagination,
`Idempotency-Key` support on POST, OpenAPI document generated from the Zod schemas.
Outbound webhooks are HMAC-signed with a timestamp and a delivery ledger with retries.

### M.6 Error taxonomy

| Code                     | HTTP | Client message                                                            | Logged         |
| ------------------------ | ---- | ------------------------------------------------------------------------- | -------------- |
| `VALIDATION_ERROR`       | 400  | field errors                                                              | info           |
| `UNAUTHENTICATED`        | 401  | "Please sign in"                                                          | info           |
| `FORBIDDEN`              | 403  | "You don't have permission…"                                              | warn (+ audit) |
| `NOT_FOUND`              | 404  | "Not found" (also used for cross-tenant access — never confirm existence) | info           |
| `CONFLICT`               | 409  | e.g. "Invoice number already exists"                                      | info           |
| `RATE_LIMITED`           | 429  | "Too many requests, retry in Ns"                                          | warn           |
| `ENTITLEMENT_REQUIRED`   | 402  | "Your plan doesn't include…" + upgrade CTA                                | info           |
| `EXTERNAL_SERVICE_ERROR` | 502  | "Service temporarily unavailable"                                         | error + Sentry |
| `AI_ERROR`               | 502  | "The assistant couldn't complete that"                                    | error + Sentry |
| `INTERNAL_ERROR`         | 500  | "Something went wrong" + `requestId`                                      | error + Sentry |

Stack traces and driver errors never reach the client. Prisma error codes are mapped
(P2002 → CONFLICT, P2025 → NOT_FOUND) inside the repository layer.

---

## N. Security architecture

### N.1 Controls by layer

| Layer         | Controls                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport     | HTTPS only, HSTS with preload, secure cookie attributes                                                                                                                                                                         |
| Headers       | strict CSP with per-request nonce (no `unsafe-inline`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, restrictive `Permissions-Policy`                        |
| Session       | DB-backed, revocable, rotated on privilege change, idle + absolute timeout                                                                                                                                                      |
| CSRF          | Server Actions' built-in origin check + `SameSite=Lax`; explicit token on non-action POST routes                                                                                                                                |
| Input         | Zod at every boundary; output encoding by React; user rich text sanitized server-side (allowlist)                                                                                                                               |
| Injection     | Prisma parameterization; no string-built SQL; whitelisted sort/filter fields; workflow conditions interpreted, never evaluated                                                                                                  |
| Authorization | server-side only, three tiers, plus the list-scope builders (§I.4)                                                                                                                                                              |
| Tenancy       | eight enforcement layers (`PLATFORM.md` §H.3)                                                                                                                                                                                   |
| Files         | private bucket; short-TTL presigned URLs issued only after a permission check; MIME + magic-byte validation; size caps; malware scan before availability; no SVG rendering from user uploads; `Content-Disposition: attachment` |
| Secrets       | env only, Zod-validated at boot, never `NEXT_PUBLIC_*`; rotation runbook; API keys stored hashed                                                                                                                                |
| Rate limiting | per IP (edge), per user, per org, per route class; stricter on auth, AI and file endpoints                                                                                                                                      |
| Data at rest  | Postgres encryption at rest; MFA secrets and OAuth tokens encrypted at the application layer (AES-256-GCM) with a key from `ENCRYPTION_KEY`                                                                                     |
| PII           | redaction map applied to logs, AI prompts and exports; configurable data-retention jobs                                                                                                                                         |
| Dependencies  | Dependabot, `npm audit` in CI, lockfile integrity                                                                                                                                                                               |
| Webhooks      | Stripe signature verification + `StripeEvent` idempotency table; inbound webhooks HMAC-verified                                                                                                                                 |
| Audit         | append-only `AuditLog` written in the same transaction as the change                                                                                                                                                            |
| Monitoring    | Sentry alerts, failed-login anomaly detection, new-device/new-country alerts, permission-change alerts                                                                                                                          |

### N.2 Security Center (product surface)

Active sessions with device/IP/last-seen and revoke; login history with success/failure and
reason; audit log with filters (actor, action, entity, date) and CSV export; role and
permission management with a diff view before saving; API key management (create/rotate/
revoke, plaintext shown once); security alerts feed; org-level policy toggles (require MFA,
allowed OAuth providers, session lifetime, IP allowlist — Business plan).

### N.3 Threat model — top risks and mitigations

| Threat                                        | Mitigation                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant data access                      | 8 enforcement layers + automated isolation matrix in CI                                                                     |
| IDOR via guessed ids                          | cuid ids + every id re-fetched and verified against `ctx.orgId` before use                                                  |
| Privilege escalation via role edit            | role changes require `organization.roles.manage`, cannot grant a permission the actor lacks, last-Owner protection, audited |
| Prompt injection through client-supplied text | untrusted content delimited and labeled; tools independently authorized; write tools need confirmation                      |
| AI data exfiltration                          | retrieval filtered by org then re-checked per record; redaction; every tool call logged                                     |
| File-based attacks                            | private bucket, magic-byte check, scan, attachment disposition, no inline SVG/HTML                                          |
| Webhook forgery/replay                        | signature + timestamp window + idempotency table                                                                            |
| Brute force / credential stuffing             | rate limits, progressive delay, login events, MFA, breach-list check                                                        |
| Billing bypass                                | entitlements enforced in services, not UI; webhook-synced state is the source of truth                                      |
| Runaway AI cost                               | per-org/user budgets, hard stop, per-run limits, cost dashboards, kill switch                                               |

---

## O. Testing architecture

### O.1 The pyramid (and the one non-standard layer)

| Layer                | Tool                   | Scope                                                                                                                                       | Target                                                                   |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Unit                 | Vitest                 | pure logic: money math, invoice totals, health scoring, condition interpreter, permission evaluator, DAG validator, date/TZ helpers         | fast, exhaustive on edge cases                                           |
| **Isolation matrix** | Vitest + real Postgres | **for every tenant model × every service method: Org A's Ctx must not read/update/delete Org B's row**                                      | generated from the model registry; a new model without coverage fails CI |
| Integration          | Vitest + Neon branch   | services against a real DB: transactions, cascades, constraints, outbox writes, audit writes                                                | all service methods                                                      |
| Authorization        | Vitest                 | every role × every permission-gated service method, asserted against an expected matrix; plus "every exported action declares a permission" | 100% of actions                                                          |
| Contract             | Vitest                 | Zod schemas ↔ AI tool params ↔ API payloads stay in sync                                                                                    |                                                                          |
| E2E                  | Playwright             | critical journeys, multi-role, multi-org                                                                                                    | see below                                                                |

### O.2 Critical E2E journeys

sign-up → create org → invite member → accept in a second browser context;
org switching keeps data separated (two orgs, assert no bleed);
deal → won → convert to project → create tasks → complete → invoice → payment → dashboard
reflects revenue; kanban drag-and-drop persists and respects dependencies; document upload →
permission check → download by an unauthorized user fails; workflow build → publish → trigger
→ approval → completion; AI assistant answers with citations and refuses out-of-scope data;
subscription upgrade unlocks a gated feature; audit log records the sequence.

### O.3 Practices

Deterministic seeded factories per module (no shared mutable fixtures); each integration test
runs in a transaction that rolls back, or against a fresh Neon branch in CI; time is injected
(`clock`) so overdue/deadline logic is testable; AI provider is a deterministic fake in tests
(recorded fixtures), with one nightly smoke test against the real provider; no network in unit
tests. Coverage gates: ≥90% on `kernel/authz`, `kernel/tenancy`, finance math and the workflow
interpreter; ≥70% overall. **A PR touching a tenant model or an action without matching
isolation/authorization tests fails CI.**

---

## P. Deployment architecture

### P.1 Environments

| Env        | Host                  | Database                                    | Purpose                            |
| ---------- | --------------------- | ------------------------------------------- | ---------------------------------- |
| local      | `next dev`            | Docker Postgres or Neon branch              | development                        |
| preview    | Vercel preview per PR | Neon branch per PR (auto-created/destroyed) | review + E2E                       |
| staging    | Vercel                | Neon staging                                | pre-production, seeded demo tenant |
| production | Vercel                | Neon production (autoscaling, PITR)         |                                    |

### P.2 Pipeline

```
PR → GitHub Actions: typecheck · lint · boundaries · unit · integration (Neon branch)
                     · build · Playwright E2E against the preview URL
merge to main → Vercel production build
   ├─ pre-deploy:  prisma migrate deploy   (expand-only, backwards compatible)
   ├─ deploy
   └─ post-deploy: health check · seed permission catalogue (idempotent) · Sentry release
```

Migrations follow **expand → migrate → contract**: never a destructive change in the same
release as the code that stops using a column. Every migration is reviewed for lock duration;
long backfills run as jobs, not in the migration.

### P.3 Runtime configuration

Node runtime for anything touching Prisma or the AI SDK; Edge only for middleware.
`maxDuration` raised on AI streaming and cron routes. Cron entries in `vercel.json`:
`*/1 * * * *` drain, `0 * * * *` sweeps, `15 2 * * *` nightly rollups + insights,
`0 8 * * 1` weekly digests. All cron routes authenticate with `CRON_SECRET`.

Caching: RSC `revalidateTag` with org-prefixed tags; Redis for hot aggregates (dashboard
metrics, permission snapshots) with explicit invalidation on the relevant events; static
assets on the CDN. Never cache anything keyed without `orgId`.

Observability: Sentry (errors + traces + release tracking), structured pino logs with
`requestId`/`orgId`/`userId` (never PII), Vercel analytics, a `/api/health` endpoint checking
DB, Redis, storage and provider reachability, and alerts on job failure rate, dead-letter
depth, webhook failures and AI error rate.

Backups/DR: Neon PITR (7–30 days), nightly logical dump to object storage, documented restore
runbook with a quarterly restore drill, storage bucket versioning.

### P.4 Environment variable strategy

All env access goes through `kernel/config/env.ts`, which parses `process.env` with Zod and
fails loudly on a malformed value. Code reads `env.STRIPE_SECRET_KEY`, never `process.env.*`
directly (lint-enforced). Server and client schemas are separate; only `NEXT_PUBLIC_*` values
may appear in the client schema.

> **The block below was the original specification. It is NOT what was built, and several
> variables in it do not exist in the code.** It is kept because the reasoning behind the
> design is still useful, but **§Q.4 is the authoritative list** and the schema in
> `src/kernel/config/env.ts` is the authority behind that.
>
> Specified and never implemented — setting any of these does nothing:
>
> - `AUTH_SECRET`, `AUTH_URL`, `ENCRYPTION_KEY` — sessions are opaque random tokens stored as
>   SHA-256 digests. There is no secret to sign with and nothing encrypted at rest.
> - `AUTH_GOOGLE_*`, `AUTH_GITHUB_*` — no OAuth provider was built.
> - `AI_PROVIDER`, `OPENAI_API_KEY`, `AI_MODEL_*`, `AI_MONTHLY_TOKEN_BUDGET` — Anthropic is
>   the only adapter and is selected by the presence of `ANTHROPIC_API_KEY` alone. Model
>   choice is a code table keyed by purpose (`src/lib/ai/router.ts`), deliberately not an
>   environment variable. The budget variable that exists is `AI_MONTHLY_BUDGET_MICROS`.
> - `STRIPE_PRICE_PRO_*`, `STRIPE_PRICE_*_YEARLY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — the
>   plans are `team` and `business`, monthly only, so the price variables are
>   `STRIPE_PRICE_TEAM` and `STRIPE_PRICE_BUSINESS`. No publishable key is needed: checkout is
>   a redirect to a provider-hosted page, so no Stripe script runs in the browser.
> - `UPSTASH_REDIS_*` — there is no cache layer.
> - `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_SENTRY_DSN` — source-map upload is not wired up, and the
>   DSN is deliberately **server-side only**: the browser reports through this application's
>   own endpoint, so no ingest host appears in the client bundle or the CSP.
> - `FEATURE_*` — there are no feature flags. Capabilities are gated by permissions.

```
# ORIGINAL SPECIFICATION — see the correction above before using this list.

# Core
NODE_ENV · APP_URL · APP_NAME

# Database
DATABASE_URL                 pooled (PgBouncer/Neon) — runtime
DIRECT_DATABASE_URL          direct — migrations only

# Auth
AUTH_SECRET · AUTH_URL
AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET
AUTH_GITHUB_ID / AUTH_GITHUB_SECRET
ENCRYPTION_KEY               AES-256-GCM key for MFA secrets / OAuth tokens

# AI
AI_PROVIDER                  anthropic | openai            (selects the adapter)
ANTHROPIC_API_KEY
OPENAI_API_KEY               optional, only if AI_PROVIDER=openai
AI_MODEL_AGENT / AI_MODEL_FAST / AI_MODEL_EMBEDDING
AI_MONTHLY_TOKEN_BUDGET

# Storage
STORAGE_DRIVER (local|s3) · STORAGE_LOCAL_DIR · STORAGE_MAX_UPLOAD_BYTES
S3_ENDPOINT · S3_REGION · S3_BUCKET · S3_ACCESS_KEY_ID · S3_SECRET_ACCESS_KEY · S3_FORCE_PATH_STYLE

# Email
RESEND_API_KEY · EMAIL_FROM

# Payments
STRIPE_SECRET_KEY · STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_PRO_MONTHLY · STRIPE_PRICE_PRO_YEARLY
STRIPE_PRICE_BUSINESS_MONTHLY · STRIPE_PRICE_BUSINESS_YEARLY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

# Infra
UPSTASH_REDIS_REST_URL · UPSTASH_REDIS_REST_TOKEN
CRON_SECRET
SENTRY_DSN · SENTRY_AUTH_TOKEN
NEXT_PUBLIC_SENTRY_DSN

# Flags
FEATURE_AI_AGENTS · FEATURE_WORKFLOWS · FEATURE_CLIENT_PORTAL
```

**What actually exists: 35 variables** — 33 server, 2 client — enumerated in §Q.4 and
enforced by `npm run check:env`, which fails CI if `.env.example` and the schema disagree.

`.env.example` is committed and contains placeholders only. Secrets live in the host's
project settings (per-environment) and a password manager; **no secret is ever committed, and
no secret is ever `NEXT_PUBLIC_`**.

---

## Q. Deployment — as built

Sections M–P describe the target architecture. This section describes what the repository
actually contains, so that nobody reads a plan as a description. Where the two differ, this
section is the truth.

### Q.1 What is in place

| Concern                 | As built                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Security headers        | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control` from `next.config.ts`; HSTS in production builds only.                                                                                                                                        |
| Content-Security-Policy | Nonce-based, minted per request in `src/proxy.ts`. `script-src` carries no `'unsafe-inline'`; `'unsafe-eval'` is development-only. Verified by an E2E test that fails on any browser-reported violation.                                                                                                     |
| Health check            | `GET /api/health` — runs `SELECT 1`, returns 200 or 503 and nothing else. Public, uncached, and deliberately uninformative on failure.                                                                                                                                                                       |
| Scheduled work          | `POST` **and** `GET /api/cron/outbox`, authenticated by `CRON_SECRET` compared in constant time. `vercel.json` schedules it every five minutes.                                                                                                                                                              |
| Logging                 | `src/kernel/observability/logger.ts` — one JSON object per line in production, readable in development, field names redacted against the same list the AI layer uses.                                                                                                                                        |
| Error reporting         | `src/kernel/observability/reporting.ts` — a port with a Sentry envelope adapter over `fetch`. Server errors report automatically through the logger; browser errors post to `/api/telemetry/error`, so no vendor script runs in the page and the DSN never reaches the client. A no-op with no `SENTRY_DSN`. |
| Outbound email          | `src/lib/email/transports.ts` — SMTP (STARTTLS mandatory) and Resend, selected by `EMAIL_PROVIDER`. Console remains the development default and is a production blocker.                                                                                                                                     |
| Configuration checks    | `npm run check:env` (does `.env.example` match the schema) and `npm run check:production` (is this configuration fit to serve real users).                                                                                                                                                                   |
| Scheduled sweep         | Advisory-locked so invocations cannot pile up, and logs `cron.outbox.completed` on every run — the absence of which is the only way to detect a stalled schedule.                                                                                                                                            |
| Crawlers                | `/robots.txt` disallows everything, alongside `robots: { index: false }` on the root layout.                                                                                                                                                                                                                 |
| Error boundaries        | `error.tsx`, `global-error.tsx`, `not-found.tsx`. A user sees a digest; the detail is in the server log under that digest.                                                                                                                                                                                   |

### Q.2 What is NOT in place

Stated plainly, because the difference between "planned" and "present" is the difference
between a runbook and a wish.

**Integrations that exist in code but have never been run against the live service.** Each
is written to the documented contract and unit-tested against constructed payloads; the
network path is not exercised, and the first real call will be the first real call:

- **Stripe.** Signature verification, idempotency, out-of-order rejection and the retry
  path are covered by tests. No live charge, no live webhook.
- **Anthropic.** Request and response translation, streaming, retry and timeout handling
  are covered with a stubbed `fetch`. No live completion.
- **SMTP and Resend.** Message construction and the full SMTP dialogue are covered against
  a scripted socket. No message has been delivered.
- **Sentry.** Envelope construction and redaction are covered. No envelope has been
  accepted by an ingest endpoint.

**Genuinely absent:**

- **No cache layer.** Every figure is computed per request. The query budgets in
  `src/lib/__tests__/query-budget.integration.test.ts` are what keep that affordable.
- **No nightly rollups.** `MetricSnapshot` exists in the schema; nothing writes to it on a
  schedule. Analytics computes live, which is correct at the volumes this is tested at and
  will need revisiting well before a tenant has millions of rows.
- **No uptime monitor and no alerting.** `/api/health` exists to be polled and
  `docs/RUNBOOK.md` §1 says exactly how — but nothing in this repository polls it, and no
  alert rule exists anywhere. This is configuration you must do.
- **No backup or restore drill.** PITR is a property of the database you provision.
  `docs/RUNBOOK.md` §2 documents the full restore procedure and marks it DRILL REQUIRED,
  because a restore that has never been executed is a hypothesis.
- **No Postgres row-level security.** Tenant isolation is enforced by the scoped Prisma
  client and proven by a generated matrix over all 66 tenant tables. RLS remains the
  defence-in-depth layer that has not been added (§D12).
- **No malware scanning on upload.** Documents record a `SKIPPED` scan status rather than
  claiming a clean one.
- **No MFA, no OAuth, no passkeys.**
- **No shared-store rate limiting.** Authentication throttling is database-backed and
  therefore correct across instances. The telemetry endpoint's limiter is in-memory and
  therefore per-instance, which is stated where it is implemented.
- **No load testing.** Query counts are pinned; throughput under concurrency is unmeasured.

### Q.3 Deploying to Vercel

1. **Provision Postgres** (Neon, Supabase, or any Postgres 17). Take two connection strings:
   the pooled one and the direct one. Migrations need the direct one; the pooler cannot run DDL
   reliably.
2. **Import the repository** into Vercel. The framework preset is Next.js; no build command
   override is needed.
3. **Set environment variables** for Production and Preview (§Q.4). `npm run check:env` lists
   exactly what the schema requires, and the build fails at boot if anything required is absent —
   which is the intended behaviour, not a fault to work around.
4. **Run migrations** before the first deploy: `DIRECT_DATABASE_URL=... npm run db:deploy`.
5. **Seed the permission catalogue:** `DATABASE_URL=... npm run db:seed`. It is idempotent and
   safe to re-run after every deploy that adds permissions.
6. **Deploy.** Then check `GET /api/health` returns 200.
7. **Confirm the cron job** is registered (Vercel → Settings → Cron Jobs). Without `CRON_SECRET`
   set, the endpoint answers 503 and no scheduled work happens.
8. **If using Stripe:** point a webhook endpoint at `https://<domain>/api/webhooks/billing`,
   subscribe to `customer.subscription.*` and `invoice.payment_*`, and put the signing secret in
   `STRIPE_WEBHOOK_SECRET`. Until that is done, plans can only be set manually, and a manual set
   is recorded as a manual decision with no paid period.

### Q.4 Required environment variables

> **Correction.** Earlier versions of this table listed `AUTH_SECRET` as required. It is
> not, and never was: no code in this repository reads it. Sessions are opaque 256-bit
> random tokens stored as SHA-256 digests, so there is no secret to sign with. Setting it
> would have done nothing while creating the impression that something was protected by
> it. It has been removed rather than added.

**Required.** The application cannot serve real users without every one of these:

| Variable                        | Purpose                               | Without it                                                            |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`                  | Pooled connection used at runtime     | Every request fails.                                                  |
| `DIRECT_DATABASE_URL`           | Direct connection, migrations only    | `prisma migrate deploy` is unreliable through a pooler.               |
| `NEXT_PUBLIC_APP_URL`           | Absolute origin, for email links      | Every link in every email is wrong.                                   |
| `NEXT_PUBLIC_APP_NAME`          | Display name                          | Defaults to "NEXUS OS". Cosmetic.                                     |
| `EMAIL_PROVIDER` + `EMAIL_FROM` | A real transport: `smtp` or `resend`  | **Sign-up strands every user** — the verification link goes to a log. |
| `STORAGE_DRIVER=s3` + `S3_*`    | Object storage                        | **Uploaded documents vanish** on an ephemeral filesystem.             |
| `CRON_SECRET`                   | Shared secret for the scheduled sweep | **No notification delivery, no workflow resumption, no reports.**     |
| `SENTRY_DSN`                    | Error reporting                       | Errors reach stdout only. No alerting, no retention.                  |

The last four were previously documented as OPTIONAL. That was wrong, and wrong in the way
that matters most: **each of them fails silently.** A deployment missing them starts, serves
pages, accepts sign-ups and looks healthy while doing none of the things those users are
waiting for. `npm run check:production` refuses a configuration missing any of them.

**Genuinely optional** — each enables a capability, and its absence is a supported state
that the product is explicit about rather than a degradation it hides:

| Variable                                           | Without it                                                   |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` (+ `AI_PROVIDER`)              | The assistant says it is not configured. It invents nothing. |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`      | No checkout; an owner sets the plan, recorded as manual.     |
| `STRIPE_PRICE_TEAM` / `STRIPE_PRICE_BUSINESS`      | That plan cannot be purchased.                               |
| `AI_MONTHLY_BUDGET_MICROS`                         | Defaults to 50 USD per organization per month.               |
| `SENTRY_ENVIRONMENT` / `_RELEASE` / `_SERVER_NAME` | Reports are harder to group. Nothing breaks.                 |
| `STORAGE_MAX_UPLOAD_BYTES`                         | Defaults to 25 MB.                                           |

Two checks, answering two different questions:

- `npm run check:env` — does `.env.example` match the schema? Runs in CI.
- `npm run check:production` — is _this_ configuration fit to serve real users? Reads
  configuration only, opens no connection, needs no credentials.
