# Operational runbook

Procedures for running NEXUS OS in production. Everything here has been written
against the code as it exists; where a step has **not** been rehearsed against real
infrastructure, it says so rather than implying it has.

> **Status of this document.** No step below marked DRILL REQUIRED has been performed.
> A restore procedure that has never been executed is a hypothesis, and calling it
> anything else is how teams discover at 3am that their backups were empty.

---

## 1. Health monitoring

### 1.1 The endpoint

```
GET /api/health
```

- **200** `{"status":"ok","checks":{"database":"ok"}}` — the instance served a request
  and reached the database.
- **503** `{"status":"unhealthy","checks":{"database":"failed"}}` — it could not.

It runs `SELECT 1` and nothing more. Deliberately:

- **It touches the one dependency without which nothing works.** A constant `{ok:true}`
  would report healthy on an instance whose credentials had expired.
- **It reads no application table.** Coupling uptime to a business table means a slow
  query on that table takes the whole service out of a load balancer.
- **It says nothing else.** No version, no hostname, no connection string, no error
  text, no configuration. It is unauthenticated, so everything it reveals is revealed
  to everybody. The detail goes to the log, under `health.database.failed`.
- **It is uncached** (`cache-control: no-store`) — a cached health check is not one.

### 1.2 Setting up an uptime monitor

Any HTTP monitor works — Better Stack, Uptime Robot, Pingdom, Checkly, or a Grafana
Cloud synthetic. Configure it as:

| Setting         | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| URL             | `https://<your-domain>/api/health`                           |
| Method          | `GET`                                                        |
| Interval        | 60 seconds                                                   |
| Expected status | `200`                                                        |
| Expected body   | contains `"status":"ok"`                                     |
| Timeout         | 10 seconds                                                   |
| Alert after     | 2 consecutive failures (one failure is usually a cold start) |
| Regions         | at least two, so a regional network fault is distinguishable |

Check the body, not only the status code. A platform error page can return 200.

### 1.3 What the monitor will NOT catch

Worth stating, because a green dashboard is persuasive:

- **A stalled cron.** `/api/health` says nothing about whether the scheduled sweep ran.
  Notifications could stop being delivered for a week behind a green check. Alert
  separately on the absence of `cron.outbox.completed` in the logs — see §1.4.
- **A broken email transport.** Sign-up appears to work right up to the point a user
  waits for a link that was never sent.
- **A failing webhook.** Subscriptions silently stop tracking the provider.
- **Correctness.** The database being reachable says nothing about the data in it.

### 1.4 Log-based alerts worth configuring

Every one of these is a structured log event with a stable name (see
`src/kernel/observability/logger.ts`). In whatever aggregator you use:

| Event                        | Alert when                 | Why it matters                                             |
| ---------------------------- | -------------------------- | ---------------------------------------------------------- |
| `cron.outbox.completed`      | **absent** for 20 minutes  | The schedule has stopped. Nothing else reveals this.       |
| `cron.outbox.failed`         | any occurrence             | The sweep is erroring; the backlog is growing.             |
| `billing.webhook.failed`     | more than 3 in 10 minutes  | Subscription state is drifting from the provider.          |
| `billing.event.stale`        | any occurrence             | Out-of-order delivery; usually benign, occasionally not.   |
| `events.subscriber.failed`   | more than 10 in 10 minutes | A subscriber is failing every delivery and retrying.       |
| `health.database.failed`     | any occurrence             | Paired with the uptime monitor, distinguishes app from DB. |
| `notifications.email.failed` | more than 5 in 10 minutes  | The transport is rejecting mail.                           |
| `client.boundary`            | a spike                    | A release broke a page for real users.                     |

---

## 2. Backup and restore

> **DRILL REQUIRED.** The procedure below is derived from the schema and migration
> setup in this repository. It has **not** been executed against a real backup,
> because no production database exists. Do not treat it as verified.

### 2.1 What the backup strategy is

This repository **contains no backup implementation**, and that is a deliberate
division of responsibility rather than an omission: point-in-time recovery is a
property of the database you provision, and re-implementing it at the application
layer would be strictly worse than what Neon, RDS or Cloud SQL already do.

What that means concretely — **you must configure this, and nothing in this repository
will tell you that you have not**:

| Provider    | What to enable                                                            |
| ----------- | ------------------------------------------------------------------------- |
| Neon        | History retention (7 days on paid plans; raise it). Branches for PITR.    |
| Supabase    | Daily backups + PITR add-on. The free tier has **no** PITR.               |
| AWS RDS     | Automated backups, retention ≥ 7 days, `backup_window` set.               |
| Cloud SQL   | Automated backups + point-in-time recovery enabled.                       |
| Self-hosted | `pg_dump` on a schedule to off-host storage, plus WAL archiving for PITR. |

**A second, independent copy.** Provider-managed PITR does not protect against the
provider account itself being lost or compromised. A weekly logical dump to separate
storage is the difference between a bad day and the end of the business:

```bash
pg_dump --format=custom --no-owner --no-acl \
        --file="nexus-$(date -u +%Y%m%dT%H%M%SZ).dump" \
        "$DIRECT_DATABASE_URL"
```

Use `DIRECT_DATABASE_URL`, not the pooled one — a transaction-mode pooler will not
give `pg_dump` a consistent snapshot.

### 2.2 Restore procedure

**Preconditions.** A dump or a PITR target, the direct connection string for an empty
target database, and this repository at the commit the backup was taken from. The last
is not optional; see §2.3.

```bash
# 1. Put the application into a state where it cannot write.
#    On Vercel: set the deployment to maintenance, or remove DATABASE_URL and redeploy.
#    Do NOT restore under live traffic — you will interleave old and new rows.

# 2. Create the target database (empty).
createdb --encoding=UTF8 --lc-collate=C --lc-ctype=C --template=template0 nexus_restore

# 3a. Restore from a logical dump.
pg_restore --no-owner --no-acl --clean --if-exists \
           --dbname="postgresql://…/nexus_restore" \
           nexus-20260929T120000Z.dump

# 3b. OR restore by provider PITR, then take the resulting branch/instance's
#     connection string as the target. Prefer this: it loses less.

# 4. Confirm the schema is at the expected migration.
DATABASE_URL="postgresql://…/nexus_restore" \
DIRECT_DATABASE_URL="postgresql://…/nexus_restore" \
  npx prisma migrate status

# 5. Apply any migrations created AFTER the backup, if you are restoring an old
#    backup into current code.
DIRECT_DATABASE_URL="postgresql://…/nexus_restore" npm run db:deploy

# 6. Re-seed the permission catalogue. Idempotent, and required if the code has
#    gained permissions since the backup.
DATABASE_URL="postgresql://…/nexus_restore" npm run db:seed

# 7. Verify before cutting over — see §2.4.

# 8. Point DATABASE_URL and DIRECT_DATABASE_URL at the restored database and
#    redeploy.
```

### 2.3 Migration compatibility

The property that makes a restore survivable is that **every migration in this
repository is expand-only**: columns and tables are added, nothing is dropped or
narrowed in the same release as the code that stops using it. Verified by inspection
of all 19 migrations at the time of writing — the most recent
(`20260929161243_billing_event_ordering`) adds two nullable columns and one with a
default, and is representative.

Two consequences that matter during a restore:

1. **Older data into newer code works.** New columns arrive null or defaulted, and
   `npm run db:deploy` fills in the gap. This is the normal restore path.
2. **Newer data into older code also works**, because the older code simply does not
   select the columns it does not know about. This is what makes a rollback possible.

If a future migration ever drops or renames a column, both properties break and this
section stops being true. The rule to keep: **a destructive change ships at least one
release after the code that stopped using the thing it destroys.**

### 2.4 Verifying a restore before cutting over

Do not trust a restore that has only been checked for "it connects".

```sql
-- Row counts against what you expect from the backup window.
SELECT 'organizations' AS t, count(*) FROM "Organization"
UNION ALL SELECT 'users',        count(*) FROM "User"
UNION ALL SELECT 'memberships',  count(*) FROM "Membership"
UNION ALL SELECT 'invoices',     count(*) FROM "Invoice"
UNION ALL SELECT 'payments',     count(*) FROM "Payment"
UNION ALL SELECT 'documents',    count(*) FROM "Document";

-- The permission catalogue must be populated, or every page 403s.
SELECT count(*) FROM "Permission";   -- expect 109 or more
SELECT count(*) FROM "Role" WHERE "organizationId" IS NULL;  -- expect 7

-- Money must still add up: an invoice's balance is derived from its payments.
SELECT i.id, i."totalMinor", i."amountPaidMinor", coalesce(sum(p."amountMinor"), 0) AS paid
FROM "Invoice" i
LEFT JOIN "Payment" p ON p."invoiceId" = i.id
GROUP BY i.id
HAVING i."amountPaidMinor" <> coalesce(sum(p."amountMinor"), 0)
LIMIT 20;   -- expect zero rows
```

Then, in the application: sign in, open the Command Center, open one invoice, and
confirm the figure matches what finance and analytics show. That crossing-check is
what the end-to-end journey test asserts, and it is the fastest manual proof that the
restore is coherent rather than merely present.

### 2.5 What a real drill requires

To move this section from DRILL REQUIRED to verified:

1. A production or production-shaped database with real volume.
2. A backup taken from it by the configured mechanism.
3. A separate, empty target to restore into.
4. An hour, and someone willing to write down the elapsed time.

Record: time to restore, row counts before and after, and anything in §2.2 that turned
out to be wrong. **Redo the drill after any migration that changes the shape of an
existing table**, and at least twice a year regardless.

### 2.6 Document storage is a separate backup

The database holds document _metadata_. The bytes are in S3, and restoring the database
without the object store gives you a working application whose every download 404s.

- Enable **versioning** on the bucket, so an overwrite or delete is recoverable.
- Enable a **lifecycle rule** for noncurrent versions rather than keeping them forever.
- A database restored to an earlier point references `storageKey`s that still exist, so
  the object store does not need to be rolled back in step — it only needs to not have
  lost anything.

---

## 3. Incident checklist

1. **Is it up?** `curl -s https://<domain>/api/health` — distinguishes app from database.
2. **What changed?** The most recent deploy, almost always.
3. **What do the logs say?** Filter by `level:error`. Events are dotted and stable, so
   `event:billing.*` narrows to a subsystem.
4. **Is the schedule running?** Look for `cron.outbox.completed` in the last 10 minutes.
   Its absence explains missing notifications, stalled workflows and missing reports at
   once.
5. **Roll back before diagnosing.** Vercel keeps previous deployments; promoting one is
   faster than understanding the fault, and expand-only migrations mean the previous
   release still runs against the current schema (§2.3).
