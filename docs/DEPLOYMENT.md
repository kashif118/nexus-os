# Deploying NEXUS OS to Vercel — staging

A first **staging** deployment, start to finish. Production has additional prerequisites; they
are listed in §9 and are deliberately not part of this guide.

> **Status.** Nothing in this guide has been executed. No Vercel project exists, no database
> has been provisioned, and no external service has been contacted. Each step is derived from
> the code in this repository; the steps that can only be confirmed by running them are marked
> **CONFIRM**, and you should treat a step as unverified until you have seen its check pass.

---

## 0. Before you start

| You will need                     | Why                                           |
| --------------------------------- | --------------------------------------------- |
| A GitHub repository               | Vercel deploys from it.                       |
| A Vercel account                  | The host.                                     |
| A PostgreSQL 17 database          | Neon, Supabase, Railway or equivalent.        |
| An S3-compatible bucket           | Cloudflare R2, AWS S3, Backblaze B2 or MinIO. |
| An email sending account          | Resend, or any SMTP relay.                    |
| A Sentry project (or equivalent)  | Error reporting.                              |
| A Stripe account **in test mode** | Only if you want to exercise billing.         |
| An Anthropic API key              | Only if you want the assistant.               |

The last two are genuinely optional — the product works without them and says so. The first
five are not: see §2.

Run this before anything else, and again after setting variables:

```bash
npm run check:production
```

It reads configuration only — no connection, no request, no credential needed — and refuses a
configuration that would fail silently at runtime.

---

## 1. GitHub

```bash
git remote add origin git@github.com:<you>/nexus-os.git
git push -u origin master
```

Confirm before pushing:

```bash
git status --short                  # expect no output
git ls-files | grep -i '^\.env'     # expect ONLY .env.example
```

`.gitignore` already excludes `.env`, `.env.local`, `.env.*.local`, `.postgres-data/` and
`.storage/`. **Never commit a real value to `.env.example`** — it is a template, and it is
public the moment the repository is.

---

## 2. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**, not in source control.
Scope them to **Preview** for staging; §9 covers Production.

> **After changing any variable in Vercel you must trigger a new deployment.** Environment
> variables are read at build and boot; an existing deployment keeps the values it was built
> with. This surprises people every time.

### 2.1 Required — the product does not work without these

| Variable               | Example / source                           | What breaks without it                                 |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `DATABASE_URL`         | Pooled string from your provider           | Every request fails.                                   |
| `DIRECT_DATABASE_URL`  | Direct (unpooled) string                   | Migrations are unreliable.                             |
| `NEXT_PUBLIC_APP_URL`  | `https://<project>-<hash>.vercel.app`      | Every link in every email is wrong.                    |
| `NEXT_PUBLIC_APP_NAME` | `NEXUS OS`                                 | Cosmetic only.                                         |
| `EMAIL_PROVIDER`       | `resend` (recommended on Vercel) or `smtp` | **Every new account is stranded** — see §4.            |
| `EMAIL_FROM`           | `NEXUS OS <no-reply@yourdomain.com>`       | Same.                                                  |
| `STORAGE_DRIVER`       | `s3`                                       | **Uploaded documents vanish** — see §5.                |
| `CRON_SECRET`          | `openssl rand -base64 32`                  | **No notifications, no workflow resumption** — see §6. |
| `SENTRY_DSN`           | From your Sentry project                   | Errors reach stdout only.                              |

Plus, depending on what you chose:

- `EMAIL_PROVIDER=resend` → `RESEND_API_KEY`
- `EMAIL_PROVIDER=smtp` → `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_PORT` /
  `SMTP_SECURE` if not 587 / STARTTLS
- `STORAGE_DRIVER=s3` → `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE=true` for R2 or MinIO

### 2.2 Optional — each enables a capability

| Variable                                                                  | Effect when absent                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                       | The assistant reports itself unavailable. Insights, usage and history still work. |
| `AI_MONTHLY_BUDGET_MICROS`                                                | Defaults to 50 USD per organization per month.                                    |
| `BILLING_PROVIDER=stripe` + `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | No checkout. An owner sets the plan, recorded as manual.                          |
| `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS`                              | That plan cannot be purchased.                                                    |
| `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_SERVER_NAME`              | Reports are harder to group.                                                      |
| `STORAGE_MAX_UPLOAD_BYTES`                                                | Defaults to 25 MB.                                                                |
| `ANTHROPIC_BASE_URL`                                                      | Defaults to the public API. For a gateway or proxy.                               |

**There is no `AUTH_SECRET`, no `AI_PROVIDER`, no `OPENAI_API_KEY` and no
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.** Earlier documentation referenced all four; none exists
in the code. `docs/OPERATIONS.md` §P.4 lists every other specified-but-never-built variable.

---

## 3. Database

1. Provision PostgreSQL 17. Take **both** connection strings — pooled and direct.
2. Enable point-in-time recovery **now**, not after you need it. `docs/RUNBOOK.md` §2.1 lists
   what to turn on per provider.
3. Apply migrations and seed the permission catalogue from your machine:

   ```bash
   DIRECT_DATABASE_URL='postgresql://…' DATABASE_URL='postgresql://…' npm run db:deploy
   DATABASE_URL='postgresql://…' npm run db:seed
   ```

   **The seed is not optional.** It writes the 109 permissions and 7 system roles. Without it
   every page answers 403, and the failure looks like a bug in authorization rather than a
   missing step.

4. **CONFIRM:**

   ```bash
   DATABASE_URL='postgresql://…' DIRECT_DATABASE_URL='postgresql://…' npx prisma migrate status
   ```

   Expect "Database schema is up to date".

Optionally, populate a demo organization to click through:

```bash
DATABASE_URL='postgresql://…' npm run db:demo
```

It refuses to run when `NODE_ENV=production`, creates accounts with a **published weak
password**, and prints the sign-in details. Staging only, and only on a deployment that is not
publicly linked.

---

## 4. Email — BLOCKED until you supply credentials

Two transports are implemented. Neither has ever sent a message, because no credentials were
available.

- **Resend** (`EMAIL_PROVIDER=resend`) — an HTTPS call. Recommended on Vercel: serverless
  functions and long-lived SMTP connections are a poor fit.
- **SMTP** (`EMAIL_PROVIDER=smtp`) — STARTTLS is mandatory. A server that does not offer it is
  refused rather than downgraded to, so credentials never cross an unencrypted socket.

`EMAIL_FROM` must be an address on a domain you control and have verified with the provider.
An unverified sender is the most common reason a first message silently does not arrive.

**CONFIRM** after deploying: sign up with a real address of your own and click the
verification link. Until that works, nobody can finish creating an account — the link goes to
the server log.

---

## 5. Document storage — BLOCKED until you supply credentials

Set `STORAGE_DRIVER=s3`. The local driver writes to the filesystem, which on Vercel is
ephemeral: uploads survive until the function instance is recycled and then disappear.

The bucket **must be private**. This application never issues a public object URL and never
presigns one — every download streams through a route handler that checks permissions first.
That costs a hop and means a leaked URL is worthless.

Enable **versioning** on the bucket so an overwrite or delete is recoverable, plus a lifecycle
rule for noncurrent versions so it does not grow forever.

For Cloudflare R2 or MinIO set `S3_FORCE_PATH_STYLE=true`; for AWS S3 set it to `false`.

**CONFIRM** after deploying: upload a document, sign in as a different user who should not see
it, and request its id directly. Expect 404 — not 403, which would confirm it exists.

---

## 6. Cron

`vercel.json` already registers the schedule:

```json
{ "crons": [{ "path": "/api/cron/outbox", "schedule": "*/5 * * * *" }] }
```

The route accepts the **GET** Vercel sends as well as a POST, and both require `CRON_SECRET`
compared in constant time. With no secret set it answers 503 and nothing runs.

**CONFIRM — this is the step most likely to be quietly wrong.** After deploying:

1. Vercel → Project → Settings → Cron Jobs — the entry should be listed.
2. Within ten minutes, find a `cron.outbox.completed` line in the function logs.

**Registration is not evidence of execution.** A cron whose secret does not match answers 404
forever and looks entirely healthy in the dashboard. The log line is the only proof.

Without a working cron: notifications are never delivered, workflow runs waiting on a delay or
an approval hang forever, and scheduled reports never generate. None of it errors.

---

## 7. Stripe — test mode, BLOCKED until you supply credentials

Leave `BILLING_PROVIDER=none` unless you are exercising billing. Plan limits still apply and
an owner sets the plan by hand, recorded as a manual decision with no paid period — so
reconciliation can always distinguish "we saw a payment" from "somebody said so".

To enable it in **test mode**:

1. Set `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY` (the `sk_test_…` key — never a live
   one in staging), `STRIPE_PRICE_TEAM` and `STRIPE_PRICE_BUSINESS`.
2. Add a webhook endpoint at `https://<domain>/api/webhooks/billing`, subscribing to
   `customer.subscription.*` and `checkout.session.completed`.
3. Put the signing secret in `STRIPE_WEBHOOK_SECRET` and **redeploy**.

**CONFIRM:** send a test event from the Stripe dashboard, then check a `BillingEvent` row
exists with `processedAt` set and `error` null.

Two behaviours worth knowing, because both are deliberate and both look like bugs:

- A **completed checkout does not grant anything.** It links the provider customer to the
  organization. The plan and status arrive with the subscription event that follows.
- An event **older** than one already applied is recorded and ignored, logged as
  `billing.event.stale`. That is the out-of-order protection, not a failure.

---

## 8. Error reporting and monitoring

Set `SENTRY_DSN` — a **server** variable. The browser reports through this application's own
`/api/telemetry/error` endpoint, so no vendor script runs in the page, the DSN never reaches
the client bundle, and the Content-Security-Policy needs no third-party exception.

**CONFIRM:** trigger a deliberate error and check the issue appears.

Then configure monitoring — `docs/RUNBOOK.md` §1:

- An uptime monitor on `GET /api/health`, checking the **body** contains `"status":"ok"`, not
  only the status code.
- The eight log-based alerts, of which the important one is the **absence** of
  `cron.outbox.completed`. A stalled schedule is invisible to an uptime check.

---

## 9. Deploy

1. Vercel → **Add New → Project** → import the repository.
2. Framework preset: **Next.js**. Root directory: **`./`**. No build command override, no
   output directory override, no install command override.
3. Node version: **22** (matches CI).
4. Add the environment variables from §2, scoped to **Preview**.
5. Deploy.

**CONFIRM, in order:**

```bash
curl -s  https://<domain>/api/health     # {"status":"ok","checks":{"database":"ok"}}
curl -sI https://<domain>/ | grep -i content-security-policy
curl -sI https://<domain>/ | grep -i strict-transport-security
curl -s  https://<domain>/robots.txt     # Disallow: /
```

Then, in a browser: sign up, verify the email, create an organization, create a project, a
task and an invoice, and confirm the same figure appears on the finance page, the analytics
page and the Command Center. That crossing-check is what the end-to-end journey asserts, and
it is the fastest manual proof the deployment is coherent.

---

## 10. Before production — additional prerequisites

Staging is not production with a different URL. Before real data:

1. **A separate database.** Never point production at a staging database.
2. **A separate Vercel environment** with Production-scoped variables, a real domain, and
   `NEXT_PUBLIC_APP_URL` set to it.
3. **Live Stripe keys** and a **separate** webhook endpoint with its own signing secret.
4. **The restore drill** — `docs/RUNBOOK.md` §2.5 — actually performed, with the elapsed time
   written down. Until then the backup strategy is a hypothesis.
5. **Alerting configured and tested** by deliberately triggering each alert.
6. **A decision on the open security items** in `docs/ENGINEERING-REPORT.md` §21: no row-level
   security, no MFA, no malware scanning on upload. Each is a documented, deliberate gap
   rather than an oversight, and each is a risk somebody should accept explicitly rather than
   inherit silently.
7. **`npm run db:demo` must never be run** against production. It refuses when
   `NODE_ENV=production`, but do not rely on that alone.
