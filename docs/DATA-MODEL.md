# NEXUS OS — E. Database Architecture

PostgreSQL + Prisma. This document defines the entity map, relationships, keys, indexes,
cascade behaviour and the tenant-isolation rules the schema must obey.

---

## E.0 Schema conventions (non-negotiable)

| Rule                | Detail                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary keys        | `id String @id @default(cuid())` — opaque, non-enumerable. No sequential integer ids on tenant data.                                                                                                          |
| Tenant column       | Every tenant-scoped table has `organizationId String` + FK, **not nullable**.                                                                                                                                 |
| First index         | Every tenant table declares `@@index([organizationId])` and compound indexes are always **org-first**: `@@index([organizationId, status, createdAt])`.                                                        |
| Uniqueness          | Business uniqueness is always scoped: `@@unique([organizationId, slug])`, `@@unique([organizationId, number])`. Global uniqueness only on `User.email`.                                                       |
| Timestamps          | `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt` on every table.                                                                                                                         |
| Soft delete         | `deletedAt DateTime?` on entities users can restore (Project, Task, Client, Document, Invoice). Filtered by default in the Prisma extension. Hard delete only via admin purge job.                            |
| Money               | `amountMinor BigInt` + `currency String @db.Char(3)`. Plus `fxRateToBase Decimal(18,8)` and `baseAmountMinor BigInt` captured at write time for cross-currency reporting. **No Float anywhere in finance.**   |
| Percentages / rates | `Decimal(9,4)`.                                                                                                                                                                                               |
| Enums               | Postgres enums via Prisma `enum` for closed sets (statuses, priorities). Open sets (categories, tags) are tables.                                                                                             |
| JSON                | `Json` only for genuinely schemaless payloads (workflow graphs, custom field values, event payloads, widget layout). Every JSON blob has a Zod schema in code and a `schemaVersion` field.                    |
| Cascade             | Child rows cascade from their parent aggregate. Cross-aggregate references use `onDelete: Restrict` or `SetNull` — never silent cascade across modules. Deleting an Organization cascades everything it owns. |
| Actor columns       | `createdById`, `updatedById` reference `User` with `onDelete: SetNull` so audit history survives user deletion.                                                                                               |
| Append-only         | `AuditLog`, `OutboxEvent`, `AIExecution`, `WorkflowRunStep`, `LoginEvent` have no update path; revoked/void is a new row.                                                                                     |

---

## E.1 Entity map by domain

### 1. Identity & tenancy

| Entity              | Key fields                                                                                                                         | Relationships                              | Notes                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `User`              | `email` **@unique**, `name`, `image`, `passwordHash?`, `emailVerifiedAt?`, `mfaEnabled`, `mfaSecretEnc?`, `status`, `lastActiveAt` | 1—N `Account`, `Session`, `Membership`     | Global (cross-tenant) identity. Contains **no** business data.              |
| `Account`           | `provider`, `providerAccountId`                                                                                                    | N—1 `User`                                 | Auth.js OAuth link. `@@unique([provider, providerAccountId])`               |
| `Session`           | `sessionToken` @unique, `expires`, `ip`, `userAgent`, `lastSeenAt`, `revokedAt?`                                                   | N—1 `User`                                 | DB sessions → revocable from Security Center.                               |
| `VerificationToken` | `identifier`, `token` @unique, `expires`, `purpose`                                                                                | —                                          | email verify, password reset, invitation                                    |
| `Organization`      | `slug` **@unique**, `name`, `logoUrl?`, `description?`, `industry?`, `timezone`, `currency`, `country`, `settings Json`, `status`  | 1—N everything                             | The tenant root.                                                            |
| `Membership`        | `organizationId`, `userId`, `status`, `joinedAt`, `invitedById?`, `title?`, `departmentId?`                                        | N—1 `User`, N—1 `Organization`, N—N `Role` | **@@unique([organizationId, userId])**. The join that makes multi-org work. |
| `MembershipRole`    | `membershipId`, `roleId`                                                                                                           | join table                                 | **@@unique([membershipId, roleId])** — a member may hold several roles.     |
| `Invitation`        | `organizationId`, `email`, `roleIds`, `token` @unique, `expiresAt`, `acceptedAt?`, `invitedById`                                   | N—1 `Organization`                         | `@@unique([organizationId, email])` while pending.                          |

### 2. Authorization

| Entity           | Key fields                                                                                                               | Notes                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Role`           | `organizationId?`, `key`, `name`, `description`, `isSystem`, `priority`                                                  | `organizationId = null` → system role template (Owner, Admin, Manager, Employee, Finance Manager, HR Manager, Client). Custom roles are org-scoped. `@@unique([organizationId, key])`. |
| `Permission`     | `key` @unique (`project.create`), `module`, `action`, `description`                                                      | Global catalogue, seeded. Never tenant-scoped.                                                                                                                                         |
| `RolePermission` | `roleId`, `permissionId`, `effect` (ALLOW/DENY)                                                                          | `@@unique([roleId, permissionId])`. DENY wins over ALLOW.                                                                                                                              |
| `ResourcePolicy` | `organizationId`, `subjectType` (USER/ROLE/TEAM), `subjectId`, `resourceType`, `resourceId`, `access` (VIEW/EDIT/MANAGE) | Record-level grants: "this team can edit this project", document ACLs. Indexed `[organizationId, resourceType, resourceId]`.                                                           |

### 3. People

| Entity            | Key fields                                                                                                                                                          | Relationships                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Department`      | `organizationId`, `name`, `parentId?`, `headMembershipId?`                                                                                                          | self-referencing tree                                                         |
| `Team`            | `organizationId`, `name`, `slug`, `description`, `departmentId?`, `leadMembershipId?`                                                                               | `@@unique([organizationId, slug])`                                            |
| `TeamMember`      | `teamId`, `membershipId`, `role`                                                                                                                                    | `@@unique([teamId, membershipId])`                                            |
| `EmployeeProfile` | `membershipId` @unique, `position`, `employmentType`, `hireDate?`, `weeklyCapacityMinutes`, `costRateMinor?`, `billRateMinor?`, `managerMembershipId?`, `location?` | 1—1 with `Membership`; HR data separated so it can carry stricter permissions |
| `Skill`           | `organizationId`, `name`, `category`                                                                                                                                | `@@unique([organizationId, name])`                                            |
| `MembershipSkill` | `membershipId`, `skillId`, `level` (1–5)                                                                                                                            | `@@unique([membershipId, skillId])`                                           |

### 4. CRM

| Entity                  | Key fields                                                                                                                                                                                                           | Relationships                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Company`               | `organizationId`, `name`, `domain?`, `industry?`, `size?`, `website?`, `address Json?`, `ownerMembershipId?`                                                                                                         | 1—N `Contact`, `Deal`, `Project`, `Invoice`                                   |
| `Contact`               | `organizationId`, `companyId?`, `firstName`, `lastName`, `email?`, `phone?`, `position?`, `ownerMembershipId?`, `isClientPortalUser`                                                                                 | `@@index([organizationId, companyId])`                                        |
| `Lead`                  | `organizationId`, `name`, `email?`, `source`, `status`, `score`, `ownerMembershipId?`, `convertedContactId?`, `convertedDealId?`, `convertedAt?`                                                                     | conversion is recorded, never destructive                                     |
| `Pipeline`              | `organizationId`, `name`, `isDefault`                                                                                                                                                                                | 1—N `PipelineStage`                                                           |
| `PipelineStage`         | `pipelineId`, `name`, `order`, `probability`, `type` (OPEN/WON/LOST)                                                                                                                                                 | `@@unique([pipelineId, order])`                                               |
| `Deal`                  | `organizationId`, `pipelineId`, `stageId`, `companyId?`, `primaryContactId?`, `title`, `valueMinor`, `currency`, `expectedCloseDate?`, `ownerMembershipId`, `status`, `wonAt?`, `lostReason?`, `convertedProjectId?` | `@@index([organizationId, stageId, status])`                                  |
| `DealStageHistory`      | `dealId`, `fromStageId?`, `toStageId`, `changedById`, `changedAt`, `durationSeconds`                                                                                                                                 | append-only → powers funnel/velocity analytics                                |
| `Activity`              | `organizationId`, `type` (CALL/EMAIL/MEETING/NOTE/TASK), `subject`, `body?`, `dueAt?`, `completedAt?`, `entityType`, `entityId`, `ownerMembershipId`                                                                 | polymorphic; `@@index([organizationId, entityType, entityId])`                |
| `CustomFieldDefinition` | `organizationId`, `entityType`, `key`, `label`, `type`, `options Json?`, `required`, `order`                                                                                                                         | `@@unique([organizationId, entityType, key])`                                 |
| `CustomFieldValue`      | `definitionId`, `entityId`, `value Json`                                                                                                                                                                             | `@@unique([definitionId, entityId])`; typed via the definition's Zod schema   |
| `Tag` / `EntityTag`     | `organizationId, name, color` / `tagId, entityType, entityId`                                                                                                                                                        | `@@unique([organizationId, name])`, `@@unique([tagId, entityType, entityId])` |

### 5. Projects & tasks

| Entity                | Key fields                                                                                                                                                                                                                                                                                           | Notes                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Project`             | `organizationId`, `key` (e.g. `NEX`), `name`, `description?`, `companyId?`, `managerMembershipId`, `status`, `priority`, `startDate?`, `dueDate?`, `completedAt?`, `budgetMinor?`, `currency`, `progressPercent`, `healthScore`, `healthStatus`, `healthComputedAt`, `visibility` (ORG/TEAM/PRIVATE) | `@@unique([organizationId, key])`, `@@index([organizationId, status, dueDate])`                           |
| `ProjectMember`       | `projectId`, `membershipId`, `role` (LEAD/CONTRIBUTOR/VIEWER), `allocationPercent`                                                                                                                                                                                                                   | `@@unique([projectId, membershipId])`                                                                     |
| `Milestone`           | `projectId`, `name`, `dueDate`, `status`, `order`, `completedAt?`                                                                                                                                                                                                                                    |                                                                                                           |
| `Task`                | `organizationId`, `projectId?`, `milestoneId?`, `parentTaskId?`, `number`, `title`, `description?`, `status`, `priority`, `assigneeMembershipId?`, `createdById`, `dueDate?`, `startDate?`, `estimateMinutes?`, `spentMinutes`, `boardOrder Decimal`, `completedAt?`                                 | `@@unique([organizationId, number])`; `boardOrder` is a fractional rank so DnD reorders touch **one** row |
| `TaskDependency`      | `taskId`, `dependsOnTaskId`, `type` (FINISH_START/START_START/…)                                                                                                                                                                                                                                     | `@@unique([taskId, dependsOnTaskId])`; cycles rejected in the service by DFS                              |
| `TaskChecklistItem`   | `taskId`, `content`, `done`, `order`, `assigneeMembershipId?`                                                                                                                                                                                                                                        |                                                                                                           |
| `Label` / `TaskLabel` | org-scoped label; join to task                                                                                                                                                                                                                                                                       | `@@unique([organizationId, name])`                                                                        |
| `Comment`             | `organizationId`, `entityType`, `entityId`, `authorMembershipId`, `body`, `bodyJson`, `parentId?`, `editedAt?`                                                                                                                                                                                       | polymorphic across task/project/deal/invoice/document                                                     |
| `Mention`             | `commentId`, `mentionedMembershipId`                                                                                                                                                                                                                                                                 | drives notifications                                                                                      |
| `Attachment`          | `organizationId`, `documentId`, `entityType`, `entityId`, `attachedById`                                                                                                                                                                                                                             | links a `Document` to any entity                                                                          |

### 6. Documents

| Entity            | Key fields                                                                                                                                                                                    | Notes                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Folder`          | `organizationId`, `name`, `parentId?`, `path`, `projectId?`, `companyId?`                                                                                                                     | materialized `path` for fast subtree queries; `@@unique([organizationId, parentId, name])` |
| `Document`        | `organizationId`, `folderId?`, `name`, `mimeType`, `sizeBytes`, `storageKey` @unique, `checksum`, `currentVersionId?`, `visibility`, `uploadedById`, `scanStatus`, `projectId?`, `companyId?` | `storageKey` = `org/{orgId}/{yyyy}/{uuid}`; never rendered to the client                   |
| `DocumentVersion` | `documentId`, `version`, `storageKey`, `sizeBytes`, `checksum`, `uploadedById`                                                                                                                | `@@unique([documentId, version])`                                                          |
| `DocumentAccess`  | via `ResourcePolicy` (resourceType = DOCUMENT)                                                                                                                                                | no separate table                                                                          |

### 7. Finance

| Entity            | Key fields                                                                                                                                                                                                                                                                                              | Notes                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Invoice`         | `organizationId`, `number`, `companyId`, `contactId?`, `projectId?`, `status`, `issueDate`, `dueDate`, `currency`, `subtotalMinor`, `discountMinor`, `taxMinor`, `totalMinor`, `amountPaidMinor`, `balanceMinor`, `notes?`, `terms?`, `sentAt?`, `paidAt?`, `voidedAt?`, `createdById`, `approvedById?` | `@@unique([organizationId, number])`; numbers issued by a per-org counter row inside the transaction |
| `InvoiceItem`     | `invoiceId`, `description`, `quantity Decimal(12,3)`, `unitPriceMinor`, `discountPercent`, `taxRatePercent`, `lineTotalMinor`, `order`                                                                                                                                                                  | totals recomputed server-side from items — the client may never send a total                         |
| `Payment`         | `organizationId`, `invoiceId?`, `companyId?`, `amountMinor`, `currency`, `method`, `receivedAt`, `reference?`, `recordedById`                                                                                                                                                                           | partial payments supported; invoice balance derived                                                  |
| `ExpenseCategory` | `organizationId`, `name`, `parentId?`                                                                                                                                                                                                                                                                   |                                                                                                      |
| `Expense`         | `organizationId`, `categoryId`, `projectId?`, `vendor?`, `amountMinor`, `currency`, `taxMinor`, `incurredOn`, `description?`, `receiptDocumentId?`, `status` (DRAFT/SUBMITTED/APPROVED/REJECTED/REIMBURSED), `submittedById`, `approvedById?`                                                           |                                                                                                      |
| `Budget`          | `organizationId`, `scopeType` (ORG/PROJECT/DEPARTMENT/CATEGORY), `scopeId?`, `periodStart`, `periodEnd`, `amountMinor`, `currency`                                                                                                                                                                      | `@@index([organizationId, scopeType, scopeId, periodStart])`                                         |
| `TaxRate`         | `organizationId`, `name`, `ratePercent`, `isDefault`                                                                                                                                                                                                                                                    |                                                                                                      |
| `NumberSequence`  | `organizationId`, `kind` (INVOICE/EXPENSE), `prefix`, `nextValue`                                                                                                                                                                                                                                       | `@@unique([organizationId, kind])`, locked with `SELECT … FOR UPDATE`                                |

### 8. Automation

| Entity            | Key fields                                                                                                                                                                                                 | Notes                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Workflow`        | `organizationId`, `name`, `description?`, `status` (DRAFT/ACTIVE/PAUSED/ARCHIVED), `triggerType`, `triggerConfig Json`, `graph Json`, `graphVersion`, `createdById`, `lastRunAt?`, `runCount`              | `graph` = validated DAG of nodes/edges (see `AI-AND-AUTOMATION.md` §L)                     |
| `WorkflowVersion` | `workflowId`, `version`, `graph Json`, `publishedById`, `publishedAt`                                                                                                                                      | runs pin a version so editing never breaks in-flight runs                                  |
| `WorkflowRun`     | `organizationId`, `workflowId`, `workflowVersionId`, `status` (QUEUED/RUNNING/WAITING/SUCCEEDED/FAILED/CANCELLED), `triggerEventId?`, `context Json`, `startedAt`, `finishedAt?`, `error Json?`, `attempt` | `@@index([organizationId, workflowId, status, startedAt])`                                 |
| `WorkflowRunStep` | `runId`, `nodeId`, `type`, `status`, `input Json`, `output Json?`, `error Json?`, `startedAt`, `finishedAt?`, `attempt`                                                                                    | append-only execution trace; makes runs resumable and debuggable                           |
| `ApprovalRequest` | `organizationId`, `runId?`, `entityType`, `entityId`, `requestedById`, `approverMembershipId?`, `approverRoleId?`, `status`, `decidedAt?`, `decisionNote?`, `expiresAt?`                                   | human-in-the-loop pause point                                                              |
| `OutboxEvent`     | `id`, `organizationId`, `type`, `actorId?`, `actorType`, `entityType`, `entityId`, `payload Json`, `occurredAt`, `processedAt?`, `attempts`, `status`                                                      | the event backbone; `@@index([status, occurredAt])`                                        |
| `OutboxDelivery`  | `eventId`, `subscriber`, `status`, `attempts`, `lastError?`                                                                                                                                                | `@@unique([eventId, subscriber])` → idempotent fan-out                                     |
| `Job`             | `organizationId?`, `kind`, `payload Json`, `runAt`, `status`, `attempts`, `maxAttempts`, `lockedAt?`, `lockedBy?`, `lastError?`, `dedupeKey?`                                                              | `@@unique([dedupeKey])`, `@@index([status, runAt])`; claimed with `FOR UPDATE SKIP LOCKED` |

### 9. AI

| Entity           | Key fields                                                                                                                                                                                                     | Notes                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIAgent`        | `organizationId?`, `key`, `name`, `description`, `systemPrompt`, `model`, `temperature`, `allowedTools String[]`, `permissionScope String[]`, `maxSteps`, `maxTokens`, `memoryStrategy`, `isSystem`, `enabled` | `organizationId = null` → built-in agent template; orgs may clone/override                                                                                  |
| `AIConversation` | `organizationId`, `agentKey`, `membershipId`, `title`, `contextType?`, `contextId?`, `lastMessageAt`, `archivedAt?`                                                                                            | context binds a thread to a project/deal/invoice                                                                                                            |
| `AIMessage`      | `conversationId`, `role`, `content Json`, `toolCalls Json?`, `tokensIn`, `tokensOut`, `costMicros`, `model`, `latencyMs`, `finishReason`                                                                       | content is a structured parts array (text / tool-call / tool-result)                                                                                        |
| `AIExecution`    | `organizationId`, `membershipId`, `agentKey`, `conversationId?`, `toolName?`, `input Json`, `output Json?`, `status`, `deniedReason?`, `durationMs`, `costMicros`                                              | append-only; **every tool call is logged here, including denials**                                                                                          |
| `AIMemory`       | `organizationId`, `scope` (ORG/AGENT/USER/ENTITY), `scopeId?`, `key`, `value Json`, `expiresAt?`                                                                                                               | agent long-term memory, permission-scoped                                                                                                                   |
| `AIInsight`      | `organizationId`, `type`, `severity`, `title`, `body`, `entityType?`, `entityId?`, `evidence Json`, `generatedAt`, `dismissedAt?`, `dismissedById?`                                                            | proactive insights surfaced on the Command Center                                                                                                           |
| `Embedding`      | `organizationId`, `entityType`, `entityId`, `chunkIndex`, `content`, `vector vector(1536)`, `contentHash`                                                                                                      | pgvector; `@@unique([organizationId, entityType, entityId, chunkIndex])`; **retrieval always filters by orgId first, then re-checks per-record permission** |
| `AIUsageCounter` | `organizationId`, `periodStart`, `tokensIn`, `tokensOut`, `costMicros`, `requests`                                                                                                                             | drives plan limits and billing                                                                                                                              |

### 10. Platform services

| Entity                                | Key fields                                                                                                                                                                 | Notes                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Notification`                        | `organizationId`, `recipientMembershipId`, `type`, `title`, `body`, `entityType?`, `entityId?`, `actorId?`, `readAt?`, `channels String[]`, `priority`                     | `@@index([recipientMembershipId, readAt, createdAt])`                                                    |
| `NotificationPreference`              | `membershipId`, `eventType`, `inApp`, `email`, `digest`                                                                                                                    | `@@unique([membershipId, eventType])`                                                                    |
| `ActivityLog`                         | `organizationId`, `entityType`, `entityId`, `actorId`, `actorType`, `verb`, `changes Json?`, `createdAt`                                                                   | the _user-facing_ feed (readable), distinct from AuditLog                                                |
| `AuditLog`                            | `organizationId?`, `actorId?`, `actorType` (USER/AGENT/SYSTEM/API_KEY), `action`, `entityType`, `entityId`, `metadata Json`, `ip?`, `userAgent?`, `requestId`, `createdAt` | the _compliance_ record: append-only, never deleted, exportable                                          |
| `LoginEvent`                          | `userId?`, `email`, `success`, `reason?`, `ip`, `userAgent`, `country?`, `createdAt`                                                                                       | brute-force detection + Security Center                                                                  |
| `SearchDocument`                      | `organizationId`, `entityType`, `entityId`, `title`, `body`, `tsv tsvector`, `visibilityScope Json`, `updatedAt`                                                           | `@@unique([organizationId, entityType, entityId])`; GIN index on `tsv`; kept fresh by the outbox indexer |
| `MetricSnapshot`                      | `organizationId`, `metric`, `dimension?`, `dimensionId?`, `periodType` (DAY/WEEK/MONTH), `periodStart`, `valueNumeric`, `valueMinor?`, `currency?`, `computedAt`           | `@@unique([organizationId, metric, dimension, dimensionId, periodType, periodStart])`                    |
| `Report`                              | `organizationId`, `type`, `name`, `parameters Json`, `status`, `format`, `documentId?`, `generatedById`, `scheduleCron?`, `generatedAt?`                                   | generated file stored as a `Document`                                                                    |
| `DashboardLayout`                     | `organizationId`, `membershipId?`, `name`, `widgets Json`, `isDefault`                                                                                                     | `membershipId = null` → org default layout                                                               |
| `Subscription`                        | `organizationId` @unique, `plan`, `status`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `seats`, `trialEndsAt?`                   |                                                                                                          |
| `UsageCounter`                        | `organizationId`, `metric` (SEATS/PROJECTS/STORAGE_BYTES/AI_TOKENS/WORKFLOW_RUNS), `periodStart`, `value`                                                                  | `@@unique([organizationId, metric, periodStart])`; checked by the entitlements service before creates    |
| `StripeEvent`                         | `stripeEventId` @unique, `type`, `payload Json`, `processedAt?`                                                                                                            | webhook idempotency                                                                                      |
| `ApiKey`                              | `organizationId`, `name`, `prefix`, `hashedKey` @unique, `scopes String[]`, `createdById`, `lastUsedAt?`, `expiresAt?`, `revokedAt?`                                       | only the hash is stored; the plaintext is shown exactly once                                             |
| `WebhookEndpoint` / `WebhookDelivery` | org-scoped outbound webhooks with HMAC signing and retry ledger                                                                                                            |                                                                                                          |

**Entity count:** ~78 tables. Roughly 62 are tenant-scoped.

---

## E.2 Core relationship diagram

```
User ──1:N── Membership ──N:1── Organization
  │              │                    │
  │              ├─N:M─ Role ─N:M─ Permission
  │              ├─N:M─ Team ─N:1─ Department
  │              └─1:1─ EmployeeProfile
  │
  └──1:N── Session / Account

Organization
  ├── Company ──1:N── Contact
  │      ├──1:N── Deal ──N:1── PipelineStage ──N:1── Pipeline
  │      │           └──1:N── DealStageHistory
  │      ├──1:N── Project
  │      └──1:N── Invoice ──1:N── InvoiceItem
  │                   └──1:N── Payment
  │
  ├── Project ──1:N── Milestone
  │      ├──1:N── ProjectMember ──N:1── Membership
  │      ├──1:N── Task ──1:N── TaskDependency (self, DAG)
  │      │          ├──1:N── TaskChecklistItem
  │      │          ├──N:M── Label
  │      │          └──1:N── Comment ──1:N── Mention
  │      ├──1:N── Expense
  │      └──1:N── Document (via Attachment, polymorphic)
  │
  ├── Folder ──1:N── Document ──1:N── DocumentVersion
  ├── Workflow ──1:N── WorkflowVersion ──1:N── WorkflowRun ──1:N── WorkflowRunStep
  │                                               └──1:N── ApprovalRequest
  ├── AIAgent ──1:N── AIConversation ──1:N── AIMessage
  │                       └──1:N── AIExecution
  ├── OutboxEvent ──1:N── OutboxDelivery
  ├── AuditLog · ActivityLog · Notification · SearchDocument · MetricSnapshot
  └── Subscription · UsageCounter · ApiKey
```

---

## E.3 Indexing strategy

| Access pattern       | Index                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Any tenant list view | `@@index([organizationId, <filter>, <sortKey>])` — org column always first                |
| Task board           | `@@index([organizationId, projectId, status, boardOrder])`                                |
| My work              | `@@index([organizationId, assigneeMembershipId, status, dueDate])`                        |
| Overdue sweeps       | partial index `WHERE status NOT IN ('DONE','CANCELLED') AND "dueDate" < now()`            |
| Invoice ageing       | `@@index([organizationId, status, dueDate])`                                              |
| Pipeline board       | `@@index([organizationId, stageId, status])`                                              |
| Activity/audit feeds | `@@index([organizationId, entityType, entityId, createdAt DESC])`                         |
| Global search        | GIN on `SearchDocument.tsv` + `pg_trgm` GIN on `title` for fuzzy                          |
| Vector search        | `ivfflat` / `hnsw` on `Embedding.vector`, always combined with an `organizationId` filter |
| Outbox drain         | `@@index([status, occurredAt])` — partial `WHERE status = 'PENDING'`                      |
| Job claim            | `@@index([status, runAt])` — partial `WHERE status = 'PENDING'`                           |
| Notifications        | `@@index([recipientMembershipId, readAt, createdAt DESC])`                                |

Rule: **no query in a list view may run without an index whose leading column is
`organizationId`.** CI runs `EXPLAIN` assertions on the top ~20 queries.

---

## E.4 Cascade and deletion behaviour

| Parent → child                                     | Behaviour                                            | Reason                                                        |
| -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Organization → everything                          | `Cascade`                                            | tenant offboarding must be complete                           |
| Project → Task, Milestone, ProjectMember           | `Cascade`                                            | children have no meaning alone                                |
| Task → checklist, labels, dependencies             | `Cascade`                                            |                                                               |
| Invoice → InvoiceItem                              | `Cascade`                                            |                                                               |
| Invoice → Payment                                  | `Restrict`                                           | never destroy a financial record; void the invoice instead    |
| Company → Deal / Project / Invoice                 | `Restrict`                                           | forces explicit reassignment                                  |
| User → Membership                                  | `Cascade`                                            | leaving the platform removes access                           |
| User → AuditLog / ActivityLog / created-by columns | `SetNull`                                            | history must survive                                          |
| Folder → Document                                  | `Restrict`                                           | deleting a folder with contents requires explicit move/delete |
| Document → DocumentVersion                         | `Cascade` + storage cleanup job                      | orphaned objects are swept by a nightly job                   |
| Workflow → WorkflowRun                             | `Restrict` (archive instead)                         | execution history is evidence                                 |
| Role → RolePermission                              | `Cascade`; system roles are `Restrict` from deletion |                                                               |

Deleting a user-facing entity sets `deletedAt` and emits `<entity>.deleted`. A **purge job**
(30-day retention, configurable) performs the hard delete and removes storage objects.

---

## E.5 Tenant isolation at the data layer

Three independent layers — a bug in any one is caught by the next:

1. **Structural** — `organizationId` is `NOT NULL` on every tenant table and every unique
   constraint is org-scoped, so cross-tenant collisions are impossible by construction.
2. **Prisma client extension** — the runtime is obtained only from `getDb(ctx)`, which
   returns a client whose `$allOperations` hook injects `where.organizationId = ctx.orgId`
   into every read and `data.organizationId = ctx.orgId` into every create for models in the
   tenant-model registry, and rejects any attempt to pass a _different_ `organizationId`.
   A separate `getSystemDb()` (auditable, used only by migrations, cron, billing webhooks
   and platform admin) is the only escape hatch, and its import is lint-restricted.
3. **PostgreSQL RLS (Phase 19)** — policies on every tenant table keyed on
   `current_setting('app.current_org_id')`, set per transaction. Defense-in-depth against a
   raw-SQL mistake or a compromised query path.

Plus a **test harness**: an automated matrix that, for every tenant model and every service
method, asserts that Org A's Ctx cannot read, update or delete Org B's row. A new model
without isolation tests fails CI.
