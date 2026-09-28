# NEXUS OS

An AI-powered **business operating system**: work, money, people, clients and documents in
one multi-tenant platform, with an automation engine and permission-scoped AI agents.

> **Status: Phase 02 of 25 — Authentication.**
> The architecture is specified in full under [`docs/`](./docs); application modules are
> built phase by phase against it. This repository currently contains the toolchain, the
> configuration kernel, the design system foundation, the identity schema and a complete
> email/password authentication system — and nothing that pretends to be more than that.
> Organizations, roles and permissions come next.

---

## Documentation

The specification is the source of truth for every phase. Read it before changing anything.

| Document                                                   | Contents                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)           | Product, system and module architecture; tech-stack decisions |
| [`docs/DATA-MODEL.md`](./docs/DATA-MODEL.md)               | ~78-table entity map, indexes, cascades, tenant isolation     |
| [`docs/PLATFORM.md`](./docs/PLATFORM.md)                   | Folder structure, authentication, multi-tenancy, RBAC         |
| [`docs/AI-AND-AUTOMATION.md`](./docs/AI-AND-AUTOMATION.md) | AI provider abstraction, agent runtime, workflow engine       |
| [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)               | API contracts, security, testing, deployment, env vars        |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md)                     | 25 phases, risks, build order, decision log                   |

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript 5.9 (strict) · Tailwind CSS v4 ·
PostgreSQL + Prisma 7 · Zod 4 · Vitest · Playwright · ESLint (with architectural boundary
enforcement) · Prettier.

Planned in later phases: Auth.js v5, TanStack Query, Recharts, Stripe, S3-compatible
storage, Redis, and a provider-agnostic AI layer defaulting to Anthropic.

## Getting started

**Requirements:** Node.js ≥ 20.11 and a PostgreSQL 15+ database (local or hosted — Neon is
what the deployment design assumes).

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

# 4. Generate the client and create the schema
npm run db:generate
npm run db:deploy

# 5. Start the development server
npm run dev                    # http://localhost:3000
```

### Database

`DATABASE_URL` is the **pooled** connection used at runtime; `DIRECT_DATABASE_URL` is the
**unpooled** connection used by migrations (DDL through a transaction-mode pooler is
unreliable). Both may point at the same server locally.

The schema is split by domain across `prisma/schema/`. It currently holds the identity
models — `User`, `Session`, `VerificationToken`, `LoginEvent` and `AuditLog`. They are
deliberately tenant-free: a user is a global identity that will join organizations through
`Membership` in the next phase.

```bash
npm run db:start        # start a local PostgreSQL (no Docker/admin needed)
npm run db:stop         # stop it
npm run db:validate     # validate the schema
npm run db:generate     # generate the Prisma client
npm run db:migrate      # create + apply a migration (development)
npm run db:deploy       # apply migrations (CI / production)
npm run db:studio       # browse data
```

`npm run db:start` runs a real PostgreSQL server from a prebuilt binary into
`.postgres-data/`. It exists so integration and end-to-end tests run against genuine
Postgres semantics rather than a mock; CI uses a service container instead.

## Authentication

Email and password, with server-side sessions. The design — and the reason it departs from
the original Auth.js plan — is recorded in [`docs/ROADMAP.md`](./docs/ROADMAP.md) §U9.

| Property         | Implementation                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| Password hashing | argon2id (19 MiB, t=2, p=1) via `@node-rs/argon2`                              |
| Session token    | 256-bit random value in an httpOnly cookie, stored only as a SHA-256 digest    |
| Session lifetime | 30 days, sliding, refreshed at most hourly; revocable from the account page    |
| Route protection | `requireUserPage()` in the server layout — the edge proxy only redirects early |
| Throttling       | 5 failures per email / 20 per IP in 15 minutes, counted from `LoginEvent`      |
| Enumeration      | Sign-in and password reset respond identically for known and unknown addresses |
| Reset tokens     | Single-use, 30-minute TTL; every session is revoked when one is used           |

Email is not delivered yet: `getMailer()` prints the message to the server console until a
Resend adapter is configured. The flows themselves are complete and covered by tests.

## Scripts

| Script                            | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `npm run dev`                     | development server                               |
| `npm run build` / `start`         | production build / serve                         |
| `npm run typecheck`               | `tsc --noEmit`                                   |
| `npm run lint`                    | ESLint, including architectural boundary rules   |
| `npm run format` / `format:check` | Prettier                                         |
| `npm run check:env`               | assert `.env.example` matches the Zod env schema |
| `npm test` / `test:watch`         | Vitest unit + integration tests                  |
| `npm run db:start` / `db:stop`    | local PostgreSQL for development and tests       |
| `npm run test:e2e`                | Playwright end-to-end tests                      |
| `npm run verify`                  | everything CI runs, in one command               |

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

These layers are enforced by `eslint-plugin-boundaries`, not by convention: the UI cannot
import a repository, services cannot import the database client, and AI tools can only
reach data through services that check permissions. Run `npm run lint` to see it work.

Three further invariants the codebase is built to guarantee:

1. **Tenant isolation is structural** — every tenant table carries a non-nullable
   `organizationId`, and the Prisma client extension injects it into every query so the safe
   path is the default one (`docs/PLATFORM.md` §H.3).
2. **Configuration is validated** — `process.env` is unreadable outside
   `src/kernel/config/env.ts`, which parses it with Zod and fails the boot on a bad value.
3. **AI never queries the database** — agents call typed tools, tools call services, and
   services enforce the _calling user's_ permissions (`docs/AI-AND-AUTOMATION.md` §J.3).

## Roadmap

Phases 02–25 cover the platform kernel, authentication, multi-tenancy, RBAC, the design
system, and then the application modules (Projects, Tasks, CRM, People, Finance, Documents,
Communication), the workflow engine, the AI layer, analytics, reporting, security, billing,
hardening and launch. See [`docs/ROADMAP.md`](./docs/ROADMAP.md) §Q.

## License

Not yet licensed. All rights reserved.
