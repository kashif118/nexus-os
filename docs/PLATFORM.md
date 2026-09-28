# NEXUS OS — F. Folder Structure · G. Authentication · H. Multi-tenancy · I. RBAC

---

## F. Folder structure

```
nexus-os/
├─ .github/workflows/          ci.yml, e2e.yml, migrate-preview.yml
├─ docs/                       architecture specs (this folder), ADRs, runbooks
├─ prisma/
│  ├─ schema/                  split schema files: base, identity, crm, projects,
│  │                           tasks, people, finance, documents, workflow, ai, platform
│  ├─ migrations/
│  └─ seed/                    permissions.ts, roles.ts, demo/ (realistic demo tenant)
├─ e2e/                        Playwright specs + fixtures
├─ public/
└─ src/
   ├─ app/
   │  ├─ (marketing)/                      landing, pricing, legal
   │  ├─ (auth)/                           sign-in, sign-up, verify, reset, mfa
   │  ├─ (onboarding)/                     create-org, join-org, invite accept
   │  ├─ (app)/[orgSlug]/                  ← every tenant screen lives under the slug
   │  │   ├─ layout.tsx                    org guard + shell (sidebar, cmd-k, notifications)
   │  │   ├─ page.tsx                      Command Center
   │  │   ├─ crm/{leads,contacts,companies,deals,pipelines}/…
   │  │   ├─ projects/[projectId]/{overview,tasks,files,finance,activity}/…
   │  │   ├─ tasks/                        my work · board · list
   │  │   ├─ people/{employees,teams,departments,workload}/…
   │  │   ├─ finance/{invoices,expenses,payments,budgets,reports}/…
   │  │   ├─ documents/[[...path]]/
   │  │   ├─ workflows/{[id]/builder,runs}/…
   │  │   ├─ ai/{assistant,agents,insights}/…
   │  │   ├─ analytics/ · reports/
   │  │   ├─ search/
   │  │   ├─ settings/{profile,organization,members,roles,teams,notifications,ai,security,billing}/
   │  │   └─ admin/{audit,sessions,api-keys,security}/
   │  ├─ api/
   │  │   ├─ auth/[...nextauth]/route.ts
   │  │   ├─ ai/chat/route.ts              streaming (Node runtime)
   │  │   ├─ files/{upload-url,download/[id]}/route.ts
   │  │   ├─ webhooks/{stripe,inbound}/route.ts
   │  │   ├─ cron/{drain,rollup,sweep,digest}/route.ts
   │  │   ├─ v1/…                          public API (API-key auth)
   │  │   └─ health/route.ts
   │  ├─ layout.tsx · error.tsx · not-found.tsx · global-error.tsx
   ├─ middleware.ts                        session presence, org slug, headers, rate-limit
   │
   ├─ modules/                             ← the business system; one folder per module
   │  └─ projects/
   │     ├─ actions.ts        'use server' commands (Zod → Ctx → service)
   │     ├─ queries.ts        RSC read functions (cached, tagged)
   │     ├─ service.ts        business rules, authz, transactions, events
   │     ├─ repository.ts     Prisma only
   │     ├─ schema.ts         Zod schemas shared by form + action + AI tool
   │     ├─ types.ts          DTOs returned to UI (never raw Prisma models)
   │     ├─ events.ts         event names + payload schemas this module emits
   │     ├─ permissions.ts    permission keys this module owns
   │     ├─ policies.ts       record-level rules (canViewProject, …)
   │     ├─ health.ts         module-specific domain logic
   │     ├─ ai-tools.ts       AI tool definitions backed by this module's services
   │     ├─ components/       module-specific UI
   │     └─ __tests__/        unit + integration + isolation tests
   │  (same shape for: crm, tasks, people, finance, documents, communication,
   │   workflows, ai, agents, analytics, reports, search, billing, admin, dashboard)
   │
   ├─ kernel/
   │  ├─ auth/          authOptions, session, mfa, password, guards
   │  ├─ tenancy/       ctx.ts (requireCtx), org-switch, membership
   │  ├─ authz/         can.ts, require.ts, permission catalogue, policy engine
   │  ├─ errors/        AppError taxonomy, toActionResult, toHttpResponse
   │  ├─ events/        catalogue.ts, outbox.ts, dispatcher.ts, subscribers.ts
   │  ├─ jobs/          queue.ts, runner.ts, handlers/, scheduler.ts
   │  ├─ audit/         write.ts, query.ts
   │  ├─ validation/    primitives.ts, pagination.ts, filters.ts
   │  ├─ ratelimit/     limiter.ts, policies.ts
   │  ├─ cache/         redis.ts, tags.ts, memo.ts
   │  ├─ config/        env.ts (Zod-validated), flags.ts, entitlements.ts
   │  ├─ observability/ logger.ts, sentry.ts, request-id.ts
   │  └─ action.ts      createAction() — the single command wrapper
   │
   ├─ lib/
   │  ├─ db.ts          getDb(ctx) · getSystemDb() · org-scope extension
   │  ├─ ai/            provider.ts (interface), providers/{anthropic,openai}.ts,
   │  │                 registry.ts, tools/, agents/, memory.ts, cost.ts, redact.ts
   │  ├─ storage/       adapter.ts, s3.ts, presign.ts, scan.ts
   │  ├─ email/         client.ts, templates/
   │  ├─ payments/      stripe.ts, entitlements.ts, webhook-handlers.ts
   │  ├─ pdf/           renderers per report type
   │  ├─ money.ts       minor-unit arithmetic, FX, formatting
   │  ├─ dates.ts       org-timezone-aware helpers
   │  └─ utils.ts
   │
   ├─ components/
   │  ├─ ui/            shadcn primitives (themed for NEXUS)
   │  ├─ layout/        AppShell, Sidebar, Topbar, OrgSwitcher, CommandPalette
   │  ├─ data/          DataTable, Filters, Pagination, BulkActions, SavedViews
   │  ├─ charts/        themed Recharts wrappers
   │  ├─ feedback/      EmptyState, ErrorState, Skeletons, Toaster
   │  └─ forms/         Field, FormDialog, DatePicker, MoneyInput, EntityPicker
   │
   ├─ styles/           globals.css, tokens.css (design tokens, light + dark)
   └─ types/            global.d.ts, branded ids, permission union type
```

Why this shape: a developer adding "Deals" touches exactly one folder and one migration.
The `modules/*` boundary means UI, transport, logic, data, events, permissions and AI tools
for a feature live together — and the lint boundary rules keep the layering honest.

---

## G. Authentication architecture

### G.1 Decision

**Auth.js v5 (NextAuth) with the Prisma adapter and database sessions.**

Rejected: Clerk/WorkOS (they would own the organization model, which is the core of this
product, and make the Security Center a stub) and a hand-rolled auth system (pointless risk).

### G.2 Supported methods

| Method                            | Notes                                                             |
| --------------------------------- | ----------------------------------------------------------------- |
| Email + password                  | argon2id; strength check via zxcvbn; breach-list check optional   |
| OAuth (Google, GitHub, Microsoft) | account linking only when the email is verified                   |
| Magic link                        | optional, for invitation acceptance                               |
| TOTP MFA                          | RFC 6238, encrypted secret, 10 single-use recovery codes (hashed) |
| Invitation flow                   | signed token, expiring, bound to `(orgId, email)`                 |

### G.3 Sessions

- **Database sessions**, not stateless JWT. This is a deliberate trade: one extra query per
  request in exchange for instant revocation, device listing, and an honest Security Center.
- Cookie: `httpOnly`, `secure`, `sameSite=lax`, `__Host-` prefix, 30-day rolling expiry,
  refreshed at most once per hour.
- Each `Session` row records IP, user agent, `lastSeenAt`. Users can revoke individual
  sessions or all others; admins can revoke any session in their org (which just drops that
  user's membership access, not their global account).
- **Session rotation** on: sign-in, password change, MFA enable/disable, email change.

### G.4 The `Ctx` construction path

```
middleware      → is there a session cookie? else redirect to /sign-in
                → extract orgSlug from the pathname, attach x-org-slug header
layout/action   → requireCtx()
   1. getServerSession()                    → userId (else AuthenticationError)
   2. user.status must be ACTIVE            → else AccountDisabledError
   3. resolve org by slug                   → else NotFoundError
   4. load Membership(userId, orgId)        → status ACTIVE
                                            → else NotAMemberError (404, never 403:
                                              we do not confirm the org exists)
   5. load roles → permissions → Set<string>
   6. load subscription entitlements
   7. return frozen Ctx { userId, orgId, membershipId, roles, permissions,
                          entitlements, requestId, actorType: 'USER' }
```

`Ctx` is memoized per request with React `cache()`. Nothing else may construct a Ctx —
including tests, which use a `makeCtx()` factory that goes through the same loader.

### G.5 Security details

- Rate limits: 5 sign-in attempts / 15 min per email **and** per IP; 3 password-reset
  requests / hour; progressive delay after failures.
- Every attempt writes a `LoginEvent` (success or failure, with reason) — feeds the
  Security Center and "new device / new country" alerts.
- Email enumeration resistance: sign-in and password-reset return identical responses and
  take constant-ish time regardless of account existence.
- Password reset tokens: single use, 30-minute TTL, invalidated on use or password change;
  all sessions revoked after a reset.
- No secrets in client components; `NEXT_PUBLIC_*` is reserved for genuinely public config.

---

## H. Multi-tenant architecture

### H.1 Model

**Shared database, shared schema, row-level tenant key**, with pooled isolation enforced in
three layers. Chosen over schema-per-tenant (migration pain at scale) and database-per-tenant
(cost and operational complexity) — and the layered enforcement recovers most of the safety.

### H.2 Tenant resolution

The org is always in the **URL path**: `/{orgSlug}/projects/…`.
Not a subdomain (simpler cookies/CSP on Vercel, no wildcard-cert work), not a cookie alone
(a stale cookie silently showing the wrong tenant is a serious bug class). The cookie only
stores a _last-used_ slug to pick a default landing org after sign-in.

Switching orgs is a navigation, so RSC caches and query keys are naturally partitioned.

### H.3 Enforcement layers

| Layer               | Mechanism                                                                                                                                         | Catches                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1. Routing          | `(app)/[orgSlug]/layout.tsx` calls `requireCtx()`; non-members get 404                                                                            | direct URL access          |
| 2. Command wrapper  | `createAction()` builds Ctx before any handler runs                                                                                               | forged form posts          |
| 3. Service          | every service fn takes `ctx` and passes `ctx.orgId` down; ids from the client are _always_ re-fetched and verified against `ctx.orgId` before use | IDOR via guessed ids       |
| 4. Data             | Prisma extension injects `organizationId` into every query for tenant models                                                                      | a forgotten `where` clause |
| 5. Database         | Postgres RLS (Phase 19) keyed on `app.current_org_id`                                                                                             | raw SQL mistakes           |
| 6. Storage          | object keys namespaced `org/{orgId}/…`; presign only after a permission check                                                                     | file URL guessing          |
| 7. Cache            | every Redis key and `revalidateTag` tag is prefixed `org:{orgId}:`                                                                                | cross-tenant cache bleed   |
| 8. Search / vectors | `organizationId` is a mandatory filter in the query builder, not a caller option                                                                  | AI retrieval leak          |

### H.4 Cross-tenant surfaces (the only places `getSystemDb()` is allowed)

Auth (email → user lookup), org creation, invitation acceptance, Stripe webhooks, cron job
claiming, platform health. Each is a named, reviewed, individually tested file; the import is
blocked everywhere else by lint.

### H.5 Membership lifecycle

`invited → active → suspended → removed`, with `Owner` protected: an org must always have at
least one active Owner (enforced in a transaction on role change and removal). Removing a
member reassigns or unassigns their work via an explicit handover step — never silent
deletion. All lifecycle transitions are audited.

---

## I. Authorization / RBAC architecture

### I.1 Three-tier model

```
1. PERMISSION (global catalogue)   'project.update', 'invoice.approve'
2. ROLE (system template or org-custom)  bundles permissions with ALLOW/DENY
3. RESOURCE POLICY (record level)  "Team Alpha can EDIT project X"
```

Evaluation order for `can(ctx, permission, resource?)`:

```
1. Owner short-circuit                      → ALLOW (except platform-reserved actions)
2. Explicit DENY in any of the actor's roles → DENY   (deny always wins)
3. Explicit ALLOW in any role                → continue to step 4
   else                                      → DENY
4. Resource scope check (if a resource was passed):
     visibility ORG      → ALLOW
     visibility TEAM     → member of an owning team? / ResourcePolicy grant?
     visibility PRIVATE  → member/owner/manager? / ResourcePolicy grant?
     ownership rules     → e.g. 'task.update.own' vs 'task.update.any'
5. Entitlement check (plan gate)            → e.g. 'workflow.manage' needs PRO+
6. ALLOW
```

### I.2 Permission catalogue (naming: `module.action[.scope]`)

```
organization.*   read update delete members.invite members.remove roles.manage
                 settings.manage billing.manage apikey.manage
project.*        create read.any read.member update.any update.own delete archive
                 member.manage budget.view budget.manage
task.*           create read update.any update.own delete assign comment
milestone.*      create update delete
crm.lead.*       create read update delete convert
crm.contact.*    create read update delete
crm.company.*    create read update delete
crm.deal.*       create read update delete stage.move value.view
people.*         read profile.read.sensitive profile.manage team.manage
                 department.manage skill.manage workload.view
finance.invoice.*  create read update delete send approve void payment.record
finance.expense.*  create read.any read.own update approve reject
finance.budget.*   read manage
finance.report.*   view export
document.*       upload read.any read.scoped update delete share folder.manage
workflow.*       read create update delete run approve
ai.*             use agent.executive agent.project agent.finance agent.crm
                 agent.research agent.reporting agent.meeting
                 settings.manage cost.view
analytics.*      view.org view.team view.own export
report.*         generate schedule view export
audit.*          read export
security.*       session.view session.revoke loginhistory.view alert.manage
```

TypeScript derives a `Permission` union type from this catalogue, so
`ctx.require('projct.update')` is a **compile error**.

### I.3 Default role → permission matrix (seeded system roles)

| Role                  | Shape of access                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**             | everything, including billing, org deletion, role management. Cannot be removed if last Owner.                                                          |
| **Admin**             | everything except billing and org deletion                                                                                                              |
| **Manager**           | full projects/tasks/CRM/documents; team analytics; read-only finance; no role or org settings                                                           |
| **Employee**          | own + assigned work; read projects they belong to; create tasks/comments/expenses; no finance, no people-sensitive, no settings                         |
| **Finance Manager**   | full finance (invoices, expenses, budgets, approve), finance analytics and reports; read-only projects/CRM for context                                  |
| **HR Manager**        | full people module including sensitive profile fields, teams, departments, skills, workload; read-only projects                                         |
| **Client** (external) | scoped to their own `Company`: read assigned projects' status, milestones, shared documents, their invoices; comment. Explicit DENY on everything else. |

Custom roles: an org may clone a system role and adjust permissions; system roles themselves
are immutable and cannot be deleted.

### I.4 Enforcement API

```ts
ctx.can('invoice.approve') // boolean, for conditional UI data
ctx.require('invoice.approve') // throws ForbiddenError
await policy.project.canView(ctx, projectId) // record-level, hits the policy engine
scope.projects(ctx) // returns a Prisma `where` fragment that
// restricts a LIST to what ctx may see
```

`scope.*` is the key to correct list endpoints: filtering happens **in the query**, never by
fetching everything and filtering in JS. Each module exposes a scope builder and it is unit
tested per role.

### I.5 UI and authorization

The client receives a **permission snapshot** (the resolved `Set<string>` for the current
org) purely to hide or disable controls. This is cosmetic. Every action and query re-checks
server-side. Rule enforced in review: _if a UI check exists without a matching server check,
it is a bug._ A dedicated test asserts that every exported action calls `require` or a policy.
