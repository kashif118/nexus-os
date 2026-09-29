import type { Permission } from '@/kernel/authz/catalogue'

/**
 * The agent registry (docs/AI-AND-AUTOMATION.md §K).
 *
 * An agent is a NAME, a set of instructions and a list of tools it may use.
 * Everything that constrains it lives here, in code, and nothing about it is
 * editable from the database:
 *
 * - **The system prompt is code.** A per-organization prompt field would be an
 *   editable security boundary: whoever can edit the prompt could ask the agent
 *   to disregard its scope. Organizations may APPEND instructions, never
 *   replace them.
 * - **The tool list is an allowlist.** An agent that is not given
 *   `searchInvoices` cannot see an invoice, whatever it is asked, and whatever
 *   its owner is permitted to do.
 * - **The permission ceiling is its owner's.** The tools check the owner's
 *   permissions, so an agent is doubly bounded: by its allowlist, and by the
 *   person it acts as.
 */

export interface AgentDefinition {
  key: string
  name: string
  description: string
  /** What a person sees before enabling it. Plain language, no jargon. */
  whatItDoes: string
  instructions: string
  /** Exact tool names this agent may call. Nothing else is offered. */
  tools: string[]
  /**
   * The permission a PERSON needs to run it — from the shared catalogue, so
   * enabling an agent is a role change like any other.
   */
  permission: Permission
  /** Permissions its OWNER must hold for it to be usable at all. */
  requiredPermissions: Permission[]
  /** Tools whose effects are writes, for the confirmation flow. */
  writeTools: string[]
}

const AGENTS = new Map<string, AgentDefinition>()

export function registerAgent(definition: AgentDefinition): void {
  if (AGENTS.has(definition.key)) throw new Error(`Duplicate agent: ${definition.key}`)
  AGENTS.set(definition.key, definition)
}

export const getAgent = (key: string): AgentDefinition | undefined => AGENTS.get(key)
export const listAgents = (): AgentDefinition[] =>
  [...AGENTS.values()].sort((a, b) => a.name.localeCompare(b.name))

/** Test seam. */
export function resetAgents(): void {
  AGENTS.clear()
}

/* -------------------------------------------------------------------------- */
/* The built-in agents                                                         */
/* -------------------------------------------------------------------------- */

const COMMON_RULES = [
  'Work only from what the tools return. If a tool gives you nothing, say so — do not fill the gap.',
  'Name the records behind every claim: an invoice number, a project key, a person.',
  'Before proposing a change, say why, in one sentence, referring to what you found.',
  'Propose few things. Three well-chosen actions are worth more than twenty.',
  'If you find nothing worth acting on, say that. An empty result is a valid outcome.',
].join('\n')

registerAgent({
  key: 'project-health',
  name: 'Project Health Agent',
  description: 'Watches delivery and flags projects drifting off track.',
  permission: 'ai.agent.project',
  whatItDoes:
    'Reviews active projects, their overdue work and their milestones, then proposes follow-up tasks for the ones in trouble.',
  instructions: [
    'You monitor project delivery.',
    'Look at active projects, their health, their progress and their overdue tasks.',
    'Identify the projects that are genuinely at risk — not merely behind on a single task.',
    'Where a project is at risk and nobody appears to be acting, propose one follow-up task for the project manager, describing the specific problem.',
    '',
    COMMON_RULES,
  ].join('\n'),
  tools: ['searchProjects', 'getProjectDetails', 'searchTasks', 'searchPeople', 'createTask'],
  requiredPermissions: ['task.create'],
  writeTools: ['createTask'],
})

registerAgent({
  key: 'receivables',
  name: 'Receivables Agent',
  description: 'Chases what is owed.',
  permission: 'ai.agent.finance',
  whatItDoes:
    'Reviews overdue invoices and proposes follow-up tasks or notifications for the largest and oldest.',
  instructions: [
    'You look after money owed to this organization.',
    'Find overdue and outstanding invoices. Rank by how much is owed and how long it has been.',
    'Propose a follow-up for the ones that matter, and say the amount and the age in the proposal.',
    'Never propose contacting a client directly. Propose internal follow-up only: this agent does not speak to customers.',
    '',
    COMMON_RULES,
  ].join('\n'),
  tools: ['searchInvoices', 'getFinancialSummary', 'searchCompanies', 'searchPeople', 'createTask'],
  requiredPermissions: ['finance.invoice.read', 'task.create'],
  writeTools: ['createTask'],
})

registerAgent({
  key: 'pipeline',
  name: 'Pipeline Agent',
  description: 'Keeps deals moving.',
  permission: 'ai.agent.crm',
  whatItDoes: 'Finds deals that have stopped progressing and proposes a next step for their owner.',
  instructions: [
    'You watch the sales pipeline.',
    'Find open deals that have not changed in some time, and the companies behind them.',
    'For the ones worth chasing, propose a task for the deal owner with a concrete next step.',
    'If you cannot see a deal value, do not guess at one or rank by it.',
    '',
    COMMON_RULES,
  ].join('\n'),
  tools: ['searchDeals', 'searchCompanies', 'searchPeople', 'createTask'],
  requiredPermissions: ['crm.deal.read', 'task.create'],
  writeTools: ['createTask'],
})

registerAgent({
  key: 'workload',
  name: 'Workload Agent',
  description: 'Spots people carrying too much.',
  permission: 'ai.agent.executive',
  whatItDoes:
    'Compares assigned work against capacity and proposes notifications where somebody is badly overloaded.',
  instructions: [
    'You watch how work is distributed.',
    'Compare what people are assigned against their capacity.',
    'Where somebody is clearly overloaded relative to their colleagues, propose notifying their manager — not the person themselves, who already knows.',
    'Counts of tasks are not effort. Say so when you use them.',
    '',
    COMMON_RULES,
  ].join('\n'),
  tools: ['getTeamWorkload', 'searchPeople', 'searchTasks', 'sendNotification'],
  requiredPermissions: ['people.workload.view'],
  writeTools: ['sendNotification'],
})

registerAgent({
  key: 'briefing',
  name: 'Daily Briefing Agent',
  description: 'Summarises what changed and what needs attention.',
  permission: 'ai.agent.reporting',
  whatItDoes:
    'Reads across projects, tasks, deals and invoices and writes a short briefing. It proposes nothing.',
  instructions: [
    'You write a short daily briefing for the person who asked.',
    'Cover: work due or overdue, projects at risk, deals needing attention, and money outstanding.',
    'Keep it to a few sentences per area, and only mention an area if there is something to say.',
    'You have no write tools. Do not offer to do anything — describe the state.',
    '',
    COMMON_RULES,
  ].join('\n'),
  tools: ['searchTasks', 'searchProjects', 'searchDeals', 'searchInvoices', 'getFinancialSummary'],
  requiredPermissions: [],
  writeTools: [],
})
