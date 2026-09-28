'use client'

import { useActionState } from 'react'

import { DataTable, type Column } from '@/components/data/data-table'
import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

import {
  addProjectMemberAction,
  createMilestoneAction,
  createProjectAction,
  removeProjectMemberAction,
  setMilestoneStatusAction,
  updateProjectAction,
  type FormState,
} from '../actions'
import {
  MILESTONE_STATUSES,
  PROJECT_PRIORITIES,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  PROJECT_VISIBILITIES,
} from '../schema'

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'destructive'> = {
  PLANNING: 'info',
  ACTIVE: 'success',
  AT_RISK: 'warning',
  ON_HOLD: 'neutral',
  COMPLETED: 'success',
  ARCHIVED: 'neutral',
}

const HEALTH_TONE: Record<string, 'success' | 'warning' | 'destructive'> = {
  HEALTHY: 'success',
  AT_RISK: 'warning',
  CRITICAL: 'destructive',
}

/** Health as a badge, used in lists and on the detail header. */
export function HealthBadge({ status, score }: { status: string; score: number }) {
  return (
    <Badge variant={HEALTH_TONE[status] ?? 'neutral'}>
      {titleCase(status)} · {score}
    </Badge>
  )
}

/** A progress bar that is honest about zero. */
export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', percent >= 100 ? 'bg-success' : 'bg-primary')}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
      <span className="text-muted-foreground tabular text-xs">{percent}%</span>
    </div>
  )
}

/* ---------------------------------- table --------------------------------- */

export interface ProjectRow {
  id: string
  key: string
  name: string
  status: string
  priority: string
  dueDate: Date | null
  progressPercent: number
  healthScore: number
  healthStatus: string
  budgetMinor: bigint | null
  currency: string
  company: { id: string; name: string } | null
  manager: { user: { name: string } } | null
  _count: { members: number; milestones: number }
}

export function ProjectTable({
  orgSlug,
  rows,
  pagination,
  sort,
  canSeeBudget,
}: {
  orgSlug: string
  rows: ProjectRow[]
  pagination: { page: number; pageSize: number; total: number }
  sort: { field: string; direction: 'asc' | 'desc' } | undefined
  canSeeBudget: boolean
}) {
  const columns: Column<ProjectRow>[] = [
    {
      id: 'name',
      header: 'Project',
      sortable: true,
      cell: (row) => (
        <span>
          <span className="text-muted-foreground font-mono text-xs">{row.key}</span> {row.name}
        </span>
      ),
    },
    {
      id: 'company',
      header: 'Client',
      cell: (row) => row.company?.name ?? <span className="text-muted-foreground">Internal</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (row) => (
        <Badge variant={STATUS_TONE[row.status] ?? 'neutral'}>{titleCase(row.status)}</Badge>
      ),
    },
    {
      id: 'healthScore',
      header: 'Health',
      sortable: true,
      cell: (row) => <HealthBadge status={row.healthStatus} score={row.healthScore} />,
    },
    {
      id: 'progress',
      header: 'Progress',
      cell: (row) => <ProgressBar percent={row.progressPercent} />,
    },
    {
      id: 'dueDate',
      header: 'Due',
      sortable: true,
      cell: (row) =>
        row.dueDate ? (
          row.dueDate.toISOString().slice(0, 10)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    // Budget is a distinct permission from project read.
    ...(canSeeBudget
      ? [
          {
            id: 'budget',
            header: 'Budget',
            numeric: true,
            cell: (row: ProjectRow) =>
              row.budgetMinor === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                formatMoney(row.budgetMinor, row.currency, { compact: true })
              ),
          } satisfies Column<ProjectRow>,
        ]
      : []),
    {
      id: 'manager',
      header: 'Manager',
      cell: (row) =>
        row.manager?.user.name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pagination={pagination}
      sort={sort}
      rowHref={(row) => `/${orgSlug}/projects/${row.id}`}
      emptyTitle="No projects yet"
      emptyDescription="A project brings a client, a team, milestones and a budget together."
    />
  )
}

/* ----------------------------------- form --------------------------------- */

export interface ProjectFormOptions {
  members: Array<{ id: string; name: string }>
  companies: Array<{ id: string; name: string }>
}

function SelectField({
  name,
  label,
  options,
  defaultValue,
  placeholder,
  errors,
}: {
  name: string
  label: string
  options: Array<{ value: string; label: string }>
  defaultValue?: string | undefined
  placeholder?: string
  errors?: string[] | undefined
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <NativeSelect id={name} name={name} defaultValue={defaultValue ?? ''}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      {errors?.length ? <p className="text-destructive text-xs">{errors.join(' ')}</p> : null}
    </div>
  )
}

export function ProjectForm({
  orgSlug,
  options,
  currency,
  canSetBudget,
  project,
}: {
  orgSlug: string
  options: ProjectFormOptions
  currency: string
  canSetBudget: boolean
  project?: {
    id: string
    key: string
    name: string
    description: string | null
    companyId: string | null
    managerMembershipId: string | null
    status: string
    priority: string
    visibility: string
    startDate: Date | null
    dueDate: Date | null
    budgetMinor: bigint | null
  }
}) {
  const action = project
    ? updateProjectAction.bind(null, orgSlug, project.id)
    : createProjectAction.bind(null, orgSlug)

  const [state, formAction] = useActionState<FormState, FormData>(action, null)
  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field
          name="key"
          label="Key"
          required
          defaultValue={project?.key}
          errors={fields?.key}
          hint="e.g. NEX"
        />
        <Field
          name="name"
          label="Project name"
          required
          defaultValue={project?.name}
          errors={fields?.name}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" defaultValue={project?.description ?? ''} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="companyId"
          label="Client"
          placeholder="Internal project"
          defaultValue={project?.companyId ?? ''}
          options={options.companies.map((company) => ({ value: company.id, label: company.name }))}
          errors={fields?.companyId}
        />
        <SelectField
          name="managerMembershipId"
          label="Manager"
          placeholder="Unassigned"
          defaultValue={project?.managerMembershipId ?? ''}
          options={options.members.map((member) => ({ value: member.id, label: member.name }))}
          errors={fields?.managerMembershipId}
        />
        <SelectField
          name="status"
          label="Status"
          defaultValue={project?.status ?? 'PLANNING'}
          options={PROJECT_STATUSES.map((value) => ({ value, label: titleCase(value) }))}
        />
        <SelectField
          name="priority"
          label="Priority"
          defaultValue={project?.priority ?? 'MEDIUM'}
          options={PROJECT_PRIORITIES.map((value) => ({ value, label: titleCase(value) }))}
        />
        <Field
          name="startDate"
          label="Start date"
          type="date"
          defaultValue={project?.startDate?.toISOString().slice(0, 10) ?? ''}
          errors={fields?.startDate}
        />
        <Field
          name="dueDate"
          label="Deadline"
          type="date"
          defaultValue={project?.dueDate?.toISOString().slice(0, 10) ?? ''}
          errors={fields?.dueDate}
        />
        <SelectField
          name="visibility"
          label="Visibility"
          defaultValue={project?.visibility ?? 'ORGANIZATION'}
          options={PROJECT_VISIBILITIES.map((value) => ({ value, label: titleCase(value) }))}
        />
        {canSetBudget ? (
          <Field
            name="budgetMinor"
            label={`Budget (${currency})`}
            inputMode="decimal"
            defaultValue={
              project?.budgetMinor !== null && project?.budgetMinor !== undefined
                ? toInput(project.budgetMinor, currency)
                : ''
            }
            errors={fields?.budgetMinor}
          />
        ) : null}
      </div>

      <SubmitButton pendingLabel="Saving…">
        {project ? 'Save changes' : 'Create project'}
      </SubmitButton>
    </form>
  )
}

/* --------------------------------- members -------------------------------- */

export function ProjectMembersPanel({
  orgSlug,
  projectId,
  members,
  options,
  canManage,
}: {
  orgSlug: string
  projectId: string
  members: Array<{
    id: string
    role: string
    allocationPercent: number
    membershipId: string
    membership: { title: string | null; user: { name: string; email: string } }
  }>
  options: ProjectFormOptions
  canManage: boolean
}) {
  const [addState, addAction] = useActionState<FormState, FormData>(
    addProjectMemberAction.bind(null, orgSlug),
    null,
  )
  const [removeState, removeAction] = useActionState<FormState, FormData>(
    removeProjectMemberAction.bind(null, orgSlug),
    null,
  )

  const assigned = new Set(members.map((member) => member.membershipId))
  const available = options.members.filter((member) => !assigned.has(member.id))
  const error = [addState, removeState].find((state) => state && !state.ok) as
    Extract<FormState, { ok: false }> | undefined

  return (
    <div className="space-y-4">
      {error ? <Alert variant="destructive">{error.error.message}</Alert> : null}

      <ul className="divide-border divide-y text-sm">
        {members.length === 0 ? (
          <li className="text-muted-foreground py-2">Nobody assigned yet.</li>
        ) : (
          members.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{member.membership.user.name}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {titleCase(member.role)}
                  {member.allocationPercent > 0 ? ` · ${member.allocationPercent}% allocated` : ''}
                </p>
              </div>
              {canManage ? (
                <form action={removeAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="membershipId" value={member.membershipId} />
                  <Button type="submit" variant="ghost" size="sm">
                    Remove
                  </Button>
                </form>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {canManage && available.length > 0 ? (
        <form action={addAction} className="space-y-2 border-t pt-3">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_6rem]">
            <SelectField
              name="membershipId"
              label="Add member"
              placeholder="Choose…"
              options={available.map((member) => ({ value: member.id, label: member.name }))}
            />
            <SelectField
              name="role"
              label="Role"
              defaultValue="CONTRIBUTOR"
              options={PROJECT_ROLES.map((value) => ({ value, label: titleCase(value) }))}
            />
            <Field
              name="allocationPercent"
              label="Alloc %"
              type="number"
              min={0}
              max={100}
              defaultValue="0"
            />
          </div>
          <SubmitButton variant="outline" size="sm" pendingLabel="Adding…">
            Add to project
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

/* ------------------------------- milestones ------------------------------- */

export function MilestonesPanel({
  orgSlug,
  projectId,
  milestones,
  canCreate,
  canUpdate,
}: {
  orgSlug: string
  projectId: string
  milestones: Array<{
    id: string
    name: string
    description: string | null
    dueDate: Date | null
    status: string
    completedAt: Date | null
  }>
  canCreate: boolean
  canUpdate: boolean
}) {
  const [createState, createAction] = useActionState<FormState, FormData>(
    createMilestoneAction.bind(null, orgSlug),
    null,
  )
  const [statusState, statusAction] = useActionState<FormState, FormData>(
    setMilestoneStatusAction.bind(null, orgSlug),
    null,
  )

  const error = [createState, statusState].find((state) => state && !state.ok) as
    Extract<FormState, { ok: false }> | undefined

  return (
    <div className="space-y-4">
      {error ? <Alert variant="destructive">{error.error.message}</Alert> : null}

      <ul className="divide-border divide-y text-sm">
        {milestones.length === 0 ? (
          <li className="text-muted-foreground py-2">No milestones yet.</li>
        ) : (
          milestones.map((milestone) => {
            const overdue =
              milestone.dueDate !== null &&
              milestone.status !== 'COMPLETED' &&
              milestone.dueDate < new Date()

            return (
              <li key={milestone.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-medium">{milestone.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {milestone.dueDate ? milestone.dueDate.toISOString().slice(0, 10) : 'No date'}
                    {overdue ? ' · overdue' : ''}
                  </p>
                </div>

                {canUpdate ? (
                  <form action={statusAction} className="flex items-center gap-2">
                    <input type="hidden" name="milestoneId" value={milestone.id} />
                    <label className="sr-only" htmlFor={`milestone-${milestone.id}`}>
                      Status for {milestone.name}
                    </label>
                    <NativeSelect
                      id={`milestone-${milestone.id}`}
                      name="status"
                      defaultValue={milestone.status}
                      className="h-7 w-36 text-xs"
                    >
                      {MILESTONE_STATUSES.map((value) => (
                        <option key={value} value={value}>
                          {titleCase(value)}
                        </option>
                      ))}
                    </NativeSelect>
                    <Button type="submit" variant="ghost" size="sm">
                      Set
                    </Button>
                  </form>
                ) : (
                  <Badge
                    variant={
                      milestone.status === 'COMPLETED'
                        ? 'success'
                        : overdue
                          ? 'destructive'
                          : 'neutral'
                    }
                  >
                    {titleCase(milestone.status)}
                  </Badge>
                )}
              </li>
            )
          })
        )}
      </ul>

      {canCreate ? (
        <form action={createAction} className="space-y-2 border-t pt-3">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
            <Field name="name" label="New milestone" required />
            <Field name="dueDate" label="Due" type="date" />
          </div>
          <SubmitButton variant="outline" size="sm" pendingLabel="Adding…">
            Add milestone
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

function toInput(amountMinor: bigint, currency: string): string {
  const exponent = currency === 'JPY' || currency === 'KRW' ? 0 : 2
  if (exponent === 0) return amountMinor.toString()
  const negative = amountMinor < 0n
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exponent + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}
