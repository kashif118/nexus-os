# NEXUS OS — J. AI Architecture · K. AI Agents · L. Workflow Engine

---

## J. AI architecture

### J.1 Layer stack

```
┌──────────────────────────────────────────────────────────────┐
│ SURFACES   Assistant · Inline actions (summarize/draft) ·    │
│            Insight cards · Report generation · Workflow AI    │
└────────────────────────┬─────────────────────────────────────┘
┌────────────────────────▼─────────────────────────────────────┐
│ ORCHESTRATION  Agent runtime: prompt assembly, tool loop,    │
│                step limits, streaming, memory, run logging    │
└────────────────────────┬─────────────────────────────────────┘
┌────────────────────────▼─────────────────────────────────────┐
│ TOOL LAYER  Typed, Zod-described tools. EVERY tool call is    │
│             authorized against Ctx and logged to AIExecution  │
└────────────────────────┬─────────────────────────────────────┘
┌────────────────────────▼─────────────────────────────────────┐
│ CONTEXT  Retrieval (SQL scopes + pgvector), always filtered   │
│          by orgId then re-checked per record                  │
└────────────────────────┬─────────────────────────────────────┘
┌────────────────────────▼─────────────────────────────────────┐
│ PROVIDER ABSTRACTION  LanguageModelProvider interface         │
│   → anthropic (default) · openai · bedrock · local            │
│   cross-cutting: retries, timeouts, cost metering, redaction, │
│   caching, model routing, circuit breaker                     │
└──────────────────────────────────────────────────────────────┘
```

> ### What was actually built — read this before the diagram above
>
> The **CONTEXT** row describes retrieval by "SQL scopes + pgvector". **Vector retrieval was
> not built.** There is no pgvector extension, no embeddings table, no embedding is ever
> computed, and no similarity search exists anywhere in the codebase. The `EmbedRequest` and
> `EmbedResult` types exist on the provider port and the Anthropic adapter's `embed()` throws
> `This provider does not offer embeddings` rather than returning a plausible zero vector.
>
> **How the AI actually reaches organization data:** through **13 typed tools**
> (`src/modules/ai/tools/`), each calling a module query boundary that enforces the calling
> user's permissions. The conversation itself carries a rolling window of the last 20 turns;
> everything else the model knows, it asked a tool for.
>
> This is a narrower capability than the specification described — the assistant cannot answer
> "what did we discuss about margins last quarter" by similarity, only by the filters the
> tools expose. It is also a **stronger** security position, and that is worth stating rather
> than presenting as a consolation: with retrieval-by-embedding, authorization is applied to
> chunks after the fact and a mis-scoped index leaks silently. With retrieval-by-tool, every
> call passes through `ctx.require()` before a single row is read, and the isolation matrix
> that covers the rest of the application covers the AI path too, because it is the same path.
>
> Semantic retrieval remains **FUTURE**. Adding it means: pgvector, an embeddings table
> carrying `organizationId` like every other tenant table, an embedding provider (Anthropic
> has no embeddings endpoint, so this means a second provider), a backfill job, and a
> re-check of every retrieved chunk against the caller's permissions before it reaches the
> prompt. The port is shaped for it; nothing else is.
>
> Similarly, of the providers listed in **PROVIDER ABSTRACTION**, only **anthropic** exists.
> `openai`, `bedrock` and `local` are the shape the port was designed to accept, not adapters
> that were written. Of the cross-cutting concerns listed, retries, timeouts, cost metering,
> redaction and model routing are built; **caching and the circuit breaker are not**.

### J.2 Provider abstraction (the swappability requirement)

```ts
interface LanguageModelProvider {
  readonly id: string
  generate(req: GenerateRequest): Promise<GenerateResult>
  stream(req: GenerateRequest): AsyncIterable<StreamPart>
  embed(req: EmbedRequest): Promise<EmbedResult>
  capabilities(): { tools: boolean; streaming: boolean; vision: boolean; maxContext: number }
  estimateCost(usage: Usage, model: string): number // micros
}
```

- `GenerateRequest` uses **our own** message/tool types, not a vendor's. Adapters translate.
- Implementation uses the Vercel AI SDK internally for transport, but the SDK's types never
  leak past the adapter — swapping transport is then also possible.
- A `ModelRouter` maps a _purpose_ to a model, configurable per org:
  `{ agent: 'claude-opus-5', summarize: 'claude-sonnet-5', classify: 'claude-haiku-4-5', embed: '…' }`.
  Callers ask for a purpose, never a model string.
- Every call passes through middleware: timeout → retry with jitter → circuit breaker →
  redaction → cost metering (`AIUsageCounter`) → audit.

### J.3 Permission-aware context (the hard requirement)

**The AI never queries the database.** It calls tools; tools call services; services enforce
authorization with the _caller's_ Ctx. The model has no privileged path — an agent run has
strictly ≤ the permissions of the user who started it.

Retrieval rules:

1. Vector/keyword search is always executed with `organizationId = ctx.orgId` as a
   non-optional filter built by the query builder, not passed by the caller.
2. Candidate results are then **re-checked per record** through the same `policy.*` functions
   the UI uses, before any content enters the prompt. (A vector index cannot express
   "private project"; the post-filter can.)
3. Sensitive fields (salary/cost rates, MFA data, API keys, other users' PII) are stripped by
   a field-level redaction map before serialization, even when the record is readable.
4. Nothing from another organization can enter a prompt — asserted by isolation tests that
   seed Org B data and assert it never appears in Org A's tool results.

### J.4 Prompt assembly

```
System:  agent instructions (immutable, from AIAgent.systemPrompt)
       + organization facts (name, currency, timezone, fiscal calendar)
       + actor facts (name, role names, permission summary — no permission *list*)
       + hard policy: never invent data; call tools for facts; state uncertainty;
         never present projections as fact; refuse out-of-scope requests
Context: pinned entity context (e.g. "current project: …") + retrieved snippets w/ citations
Memory:  AIMemory entries in scope, summarized
History: rolling window + rolling summary of older turns
User:    the request
```

Untrusted content (client emails, uploaded documents, comments, lead notes) is wrapped in
explicit delimiters and labeled as data, with an instruction that content inside is never an
instruction — **prompt-injection defense**, backed by the fact that tools are authorized
independently, so a successful injection still cannot exceed the user's permissions.

### J.5 AI tool system

Tools are declared once and reused by all agents and by workflow AI actions:

```ts
defineTool({
  name: 'searchProjects',
  description: '…',
  parameters: z.object({ query: z.string().optional(), status: …, limit: z.number().max(50).default(20) }),
  requiredPermissions: ['project.read.any'],   // checked BEFORE invocation
  sideEffect: 'read',                          // 'read' | 'write' | 'external'
  handler: (ctx, args) => projectService.search(ctx, args),   // service, never Prisma
})
```

Read tools: `searchProjects`, `searchTasks`, `searchClients`, `searchDeals`, `searchInvoices`,
`searchDocuments`, `searchPeople`, `getProjectDetails`, `getTaskDetails`, `getClientDetails`,
`getInvoiceDetails`, `getFinancialSummary`, `getTeamWorkload`, `getActivityFeed`,
`getAnalyticsMetric`, `semanticSearch`.

Write tools: `createTask`, `updateTask`, `assignTask`, `createComment`, `createActivity`,
`createDocumentDraft`, `generateReport`, `sendNotification`, `requestApproval`.

Write-tool rules:

- gated by `sideEffect: 'write'` → requires explicit user confirmation in interactive
  sessions, or an `autonomy: 'autonomous'` grant in a workflow;
- idempotency key derived from `(runId, nodeId, toolName, argsHash)`;
- rate limited per run and per org;
- always audited with `actorType: 'AGENT'` and the initiating user recorded.

### J.6 AI surfaces beyond chat

| Surface                | Behaviour                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Insight engine**     | nightly + event-triggered jobs run bounded analyses (overdue clusters, margin erosion, stalled deals, workload imbalance, at-risk projects) and write `AIInsight` rows with evidence links. The Command Center renders these as cards. Every insight cites the records it came from. |
| **Inline actions**     | "Summarize this project", "Draft reminder for this invoice", "Extract action items" — single-shot, streamed, with a diff/preview before anything is saved.                                                                                                                           |
| **Meeting pipeline**   | notes → summary → decisions → action items → **proposed** tasks with assignees/deadlines → user confirms → `createTask` per accepted item, linked back to the source note. Nothing is created without confirmation.                                                                  |
| **Report narration**   | numbers are computed by the analytics engine in SQL; the model only writes the narrative around verified figures and may not alter them.                                                                                                                                             |
| **Workflow AI action** | `ai.generate` / `ai.analyze` nodes with a constrained output schema.                                                                                                                                                                                                                 |

### J.7 Guardrails

Output schemas validated with Zod (bad output → one repair attempt → fail the step);
hallucination control by citation requirement on factual claims; **financial projections are
always labeled as estimates with their basis stated**; per-org and per-user token budgets with
a hard stop; kill switch per agent and org-wide; full request/response retained (configurable
30–90 days) for debugging, with PII redaction on export.

---

## K. AI Agent architecture

### K.1 Agent definition

```ts
interface AgentDefinition {
  key: string
  name: string
  description: string
  systemPrompt: string
  purpose: ModelPurpose // resolves through the ModelRouter
  allowedTools: ToolName[] // allowlist, not a denylist
  permissionScope: Permission[] // intersected with the user's permissions
  memory: {
    strategy: 'none' | 'summary' | 'vector' | 'hybrid'
    scope: 'user' | 'org' | 'entity'
    ttlDays?: number
  }
  limits: {
    maxSteps: number
    maxTokens: number
    maxToolCalls: number
    maxDurationMs: number
    maxCostMicros: number
  }
  autonomy: 'read_only' | 'suggest' | 'autonomous_with_approval'
  contextBuilders: ContextBuilder[]
}
```

Agents are seeded as system templates (`organizationId = null`) and may be cloned and tuned
per organization. **Effective permissions = agent.permissionScope ∩ user.permissions** — an
agent can only ever narrow, never widen.

### K.2 The seven agents

| Agent         | Scope                                          | Tools                                                                       | Autonomy                 |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| **Executive** | org-wide overview within the user's visibility | all read tools + `generateReport`                                           | suggest                  |
| **Project**   | projects the user can see                      | project/task/document reads, `createTask`, `updateTask`, `assignTask`       | autonomous_with_approval |
| **Finance**   | finance module                                 | invoice/expense/budget/analytics reads, `generateReport`, `requestApproval` | suggest                  |
| **CRM**       | leads, contacts, companies, deals              | CRM reads + `createActivity`, `createComment`                               | suggest                  |
| **Research**  | external + internal synthesis                  | internal reads + (optional) web fetch via a sandboxed adapter               | read_only                |
| **Reporting** | report building                                | analytics reads + `generateReport`                                          | suggest                  |
| **Meeting**   | notes → decisions → tasks                      | `createTask`, `assignTask`, `createComment`                                 | autonomous_with_approval |

Finance Agent carries an extra system rule: _never state a projection as fact; always give
the basis and the period; never advise on tax or legal matters._

### K.3 Execution runtime

```
start(agentKey, input, ctx)
  ├─ resolve definition · check 'ai.use' + 'ai.agent.<key>' · check plan entitlement
  ├─ check budget (AIUsageCounter vs plan limit) → 402-style AppError if exceeded
  ├─ open AIConversation (or continue) · create AIExecution row (status RUNNING)
  ├─ build prompt (§J.4) with context builders
  └─ loop up to limits.maxSteps:
        provider.stream(...)
        on tool_call:
          ├─ tool in allowedTools?              else → refuse + log
          ├─ ctx.can(tool.requiredPermissions)? else → log DENIED, tell the model it lacks access
          ├─ sideEffect 'write' && autonomy != autonomous → emit a confirmation request to UI
          ├─ execute via service with ctx (timeout + idempotency key)
          └─ append AIExecution row (input, output, duration, cost)
        on text: stream to the client
  ├─ persist AIMessage rows with usage/cost
  ├─ update memory per strategy (summary write-back / vector upsert)
  └─ close AIExecution (SUCCEEDED/FAILED/LIMIT_EXCEEDED) + AuditLog(actorType='AGENT')
```

Streaming via a Node-runtime Route Handler; the client renders text, tool-call chips (with
what the agent looked at) and confirmation prompts for write actions. **Transparency is a
product feature**: users can always see which records an answer came from.

### K.4 Memory

- **Short-term:** rolling message window plus a rolling summary of older turns.
- **Medium-term:** `AIMemory` key/value facts per scope (user preferences: "reports in EUR";
  entity facts: "this client prefers monthly invoicing"), written only from confirmed content.
- **Long-term:** pgvector over org content — _not_ over conversations by default (privacy).
- Memory is org- and permission-scoped and is redacted on read exactly like retrieval.

---

## L. Workflow automation architecture

### L.1 Model

A workflow is a **versioned, validated DAG**:

```ts
type WorkflowGraph = {
  schemaVersion: 1
  nodes: Array<
    | { id; type: 'trigger'; trigger: TriggerType; config: Json }
    | { id; type: 'condition'; expression: ConditionExpression } // AND/OR tree
    | { id; type: 'action'; action: ActionType; config: Json }
    | { id; type: 'branch'; branches: Array<{ id; expression }> }
    | { id; type: 'delay'; config: { seconds?; until?; businessHours? } }
    | { id; type: 'approval'; config: { approverRoleId?; approverMembershipId?; timeoutHours } }
    | { id; type: 'loop'; config: { overPath; maxIterations } }
  >
  edges: Array<{ from: string; to: string; branch?: string }>
}
```

Validated by Zod **and** a graph validator: exactly one trigger, no cycles, all edges
resolvable, every referenced field exists on the trigger's entity type, action configs
type-check against their schema, and the required permissions are held by the workflow's
owner. Publishing creates an immutable `WorkflowVersion`; running workflows pin their version.

### L.2 Registries (the extensibility mechanism)

```ts
registerTrigger({ type: 'invoice.overdue', label, entityType: 'Invoice',
  eventTypes: ['invoice.overdue'], configSchema, fields: FieldDescriptor[] })

registerAction({ type: 'ai.generate', label, category: 'AI',
  configSchema, requiredPermissions: ['ai.use'], sideEffect: 'external',
  execute: async (ctx, config, runContext) => …, idempotent: true })
```

Adding a trigger or action = one registry entry. The builder UI, the validator, the
condition field-picker and the docs are all **generated from the registry** — no UI change
needed to ship a new action.

**Triggers (v1):** entity events (`lead.created`, `client.created`, `project.created`,
`project.status_changed`, `task.created`, `task.completed`, `task.overdue`,
`invoice.created`, `invoice.sent`, `invoice.overdue`, `payment.received`,
`expense.submitted`, `document.uploaded`, `deal.stage_changed`, `deal.won`, `deal.lost`),
plus `schedule.cron`, `manual`, and `webhook.inbound`.

**Conditions:** field comparisons (`eq ne gt gte lt lte contains startsWith in between
isEmpty changed changedTo`) over the trigger entity and its safe relations, plus date
arithmetic (`dueDate < now - 7d`), role/user checks, custom fields, and `and`/`or`/`not`
nesting. Evaluated by a small interpreter over a **whitelisted field map** — no `eval`, no
arbitrary property access.

**Actions (v1):** `task.create`, `task.assign`, `record.update` (whitelisted fields),
`notification.send`, `email.send`, `ai.generate`, `ai.analyze`, `report.generate`,
`approval.request`, `activity.log`, `webhook.call`, `document.create`, `invoice.send`,
`tag.add`, `member.notify_manager`.

### L.3 Execution

```
OutboxEvent drained
  → WorkflowEngine.match(event)         index on (orgId, triggerType, status=ACTIVE)
  → for each matching ACTIVE workflow: create WorkflowRun(QUEUED) + enqueue Job
  → JobRunner claims (FOR UPDATE SKIP LOCKED) → interpreter:
       for each node in topological order from the trigger:
         write WorkflowRunStep(RUNNING) → execute → write output
         condition false          → stop that path
         approval node            → run status WAITING, persist, exit (resumed by decision)
         delay node               → schedule a resume Job at runAt, exit
         action error             → retry per policy (3×, exponential) → else FAILED
  → run finishes → emit workflow.run.completed/failed → notify owner on failure
```

Guarantees and guards:

- **Idempotency** per `(runId, nodeId)`; replaying a step never duplicates side effects.
- **Resumability**: state lives in `WorkflowRunStep`, so approvals and delays survive
  deploys and serverless timeouts.
- **Loop protection**: workflow-triggered events are tagged with their `runId` and a
  `causationDepth`; depth > 3 stops propagation. A workflow cannot re-trigger itself.
- **Limits per plan**: runs/month, max nodes, max steps per run, max run duration.
- **Serverless time budget**: each job execution has a wall-clock budget (~50s); a run that
  exceeds it checkpoints and re-enqueues rather than being killed mid-flight.
- **Permissions**: actions execute under a Ctx derived from the workflow's owner, intersected
  with the workflow's declared scope; `actorType: 'WORKFLOW'` in audit.
- **Observability**: a run detail view shows every step with input/output/error/duration,
  plus "test run" mode that executes against a sample event with side effects mocked.

### L.4 The worked example from the brief

```
TRIGGER  invoice.overdue
  └─ CONDITION  invoice.totalMinor > 100000 (=$1000)
       └─ ACTION  ai.analyze     → client payment history summary → run context
            └─ ACTION  ai.generate  → reminder email draft (constrained output schema)
                 └─ NODE  approval  → Finance Manager, 48h timeout
                      ├─ approved → ACTION email.send  → ACTION notification.send
                      │                → ACTION activity.log → ACTION task.create
                      │                  ("follow up in 7 days", assignee = account owner)
                      └─ rejected/timeout → ACTION notification.send (escalate to Owner)
```

Every node writes a `WorkflowRunStep`; the whole chain is replayable and auditable.
