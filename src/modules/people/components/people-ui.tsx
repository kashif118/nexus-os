'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Avatar, AvatarFallback, initialsOf } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

import {
  addTeamMemberAction,
  createDepartmentAction,
  createSkillAction,
  createTeamAction,
  removeTeamMemberAction,
  saveProfileAction,
  setMemberSkillAction,
  type FormState,
} from '../actions'
import { EMPLOYMENT_TYPES, TEAM_ROLES } from '../schema'

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')

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

/* -------------------------------- directory ------------------------------- */

export interface PersonRow {
  membershipId: string
  name: string
  email: string
  position: string | null
  departmentName: string | null
  skills: Array<{ id: string; name: string; level: number }>
}

export function PeopleDirectory({ orgSlug, people }: { orgSlug: string; people: PersonRow[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {people.map((person) => (
        <li key={person.membershipId}>
          <Link
            href={`/${orgSlug}/people/${person.membershipId}`}
            className="bg-card hover:border-primary/40 flex items-start gap-3 rounded-lg border p-4 transition-colors"
          >
            <Avatar>
              <AvatarFallback>{initialsOf(person.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 space-y-1">
              <p className="truncate font-medium">{person.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {person.position ?? 'No position set'}
                {person.departmentName ? ` · ${person.departmentName}` : ''}
              </p>
              {person.skills.length > 0 ? (
                <div className="flex flex-wrap gap-1 pt-1">
                  {person.skills.slice(0, 3).map((skill) => (
                    <Badge key={skill.id} variant="neutral">
                      {skill.name}
                    </Badge>
                  ))}
                  {person.skills.length > 3 ? (
                    <span className="text-muted-foreground text-xs">
                      +{person.skills.length - 3}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/* --------------------------------- profile -------------------------------- */

export function ProfileForm({
  orgSlug,
  membershipId,
  options,
  currency,
  canSeeSensitive,
  profile,
}: {
  orgSlug: string
  membershipId: string
  options: {
    members: Array<{ id: string; name: string }>
    departments: Array<{ id: string; name: string }>
  }
  currency: string
  canSeeSensitive: boolean
  profile: {
    position: string | null
    employmentType: string
    hireDate: Date | null
    location: string | null
    weeklyCapacityMinutes: number
    departmentId: string | null
    managerMembershipId: string | null
    costRateMinor: bigint | null
    billRateMinor: bigint | null
  } | null
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    saveProfileAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined
  const formError = state && !state.ok && !state.error.fields ? state.error.message : null

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {formError ? <Alert variant="destructive">{formError}</Alert> : null}
      <input type="hidden" name="membershipId" value={membershipId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="position" label="Position" defaultValue={profile?.position ?? ''} />
        <SelectField
          name="employmentType"
          label="Employment"
          defaultValue={profile?.employmentType ?? 'FULL_TIME'}
          options={EMPLOYMENT_TYPES.map((value) => ({ value, label: titleCase(value) }))}
        />
        <SelectField
          name="departmentId"
          label="Department"
          placeholder="None"
          defaultValue={profile?.departmentId ?? ''}
          options={options.departments.map((department) => ({
            value: department.id,
            label: department.name,
          }))}
        />
        <SelectField
          name="managerMembershipId"
          label="Manager"
          placeholder="None"
          defaultValue={profile?.managerMembershipId ?? ''}
          options={options.members
            .filter((member) => member.id !== membershipId)
            .map((member) => ({ value: member.id, label: member.name }))}
          errors={fields?.managerMembershipId}
        />
        <Field
          name="hireDate"
          label="Start date"
          type="date"
          defaultValue={profile?.hireDate?.toISOString().slice(0, 10) ?? ''}
        />
        <Field name="location" label="Location" defaultValue={profile?.location ?? ''} />
        <Field
          name="weeklyCapacityMinutes"
          label="Weekly capacity (minutes)"
          type="number"
          min={0}
          defaultValue={String(profile?.weeklyCapacityMinutes ?? 2400)}
          hint="2400 is a 40-hour week."
        />
      </div>

      {/* Rates need people.profile.read.sensitive on top of profile.manage:
          editing a job title is not the same trust as editing pay. */}
      {canSeeSensitive ? (
        <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          <Field
            name="costRateMinor"
            label={`Cost rate (${currency} / hour)`}
            inputMode="decimal"
            defaultValue={profile?.costRateMinor ? toInput(profile.costRateMinor) : ''}
            errors={fields?.costRateMinor}
          />
          <Field
            name="billRateMinor"
            label={`Bill rate (${currency} / hour)`}
            inputMode="decimal"
            defaultValue={profile?.billRateMinor ? toInput(profile.billRateMinor) : ''}
            errors={fields?.billRateMinor}
          />
        </div>
      ) : null}

      <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
    </form>
  )
}

/** Rates, shown only when permitted — and saying which it is. */
export function RatePanel({
  costRateMinor,
  billRateMinor,
  currency,
  canSeeSensitive,
}: {
  costRateMinor: bigint | null
  billRateMinor: bigint | null
  currency: string
  canSeeSensitive: boolean
}) {
  if (!canSeeSensitive) {
    return (
      <p className="text-muted-foreground text-sm">
        Pay rates are restricted. They are not sent to your browser at all.
      </p>
    )
  }

  if (costRateMinor === null && billRateMinor === null) {
    return <p className="text-muted-foreground text-sm">No rates recorded.</p>
  }

  return (
    <dl className="space-y-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-muted-foreground">Cost rate</dt>
        <dd className="font-medium">
          {costRateMinor === null ? '—' : formatMoney(costRateMinor, currency)}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-3">
        <dt className="text-muted-foreground">Bill rate</dt>
        <dd className="font-medium">
          {billRateMinor === null ? '—' : formatMoney(billRateMinor, currency)}
        </dd>
      </div>
    </dl>
  )
}

/* -------------------------------- workload -------------------------------- */

export function WorkloadTable({
  orgSlug,
  rows,
  unestimatedTasks,
}: {
  orgSlug: string
  rows: Array<{
    membershipId: string
    name: string
    openTasks: number
    overdueTasks: number
    estimatedMinutes: number
    capacityMinutes: number
    utilisationPercent: number
    projects: number
  }>
  unestimatedTasks: number
}) {
  return (
    <div className="space-y-3">
      {/* The caveat is part of the number: utilisation only counts estimated
          work, and pretending otherwise would invent data. */}
      {unestimatedTasks > 0 ? (
        <Alert>
          {unestimatedTasks} open task{unestimatedTasks === 1 ? ' has' : 's have'} no estimate, so
          they are not counted in utilisation.
        </Alert>
      ) : null}

      <ul className="divide-border divide-y">
        {rows.map((row) => {
          const over = row.utilisationPercent > 100
          return (
            <li key={row.membershipId} className="flex items-center gap-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/${orgSlug}/people/${row.membershipId}`}
                  className="font-medium hover:underline"
                >
                  {row.name}
                </Link>
                <p className="text-muted-foreground text-xs">
                  {row.openTasks} open · {row.projects} project{row.projects === 1 ? '' : 's'}
                  {row.overdueTasks > 0 ? ` · ${row.overdueTasks} overdue` : ''}
                </p>
              </div>

              <div className="flex w-40 items-center gap-2">
                <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      over
                        ? 'bg-destructive'
                        : row.utilisationPercent > 80
                          ? 'bg-warning'
                          : 'bg-primary',
                    )}
                    style={{ width: `${Math.min(100, row.utilisationPercent)}%` }}
                  />
                </div>
                <span className={cn('tabular w-12 text-right text-xs', over && 'text-destructive')}>
                  {row.utilisationPercent}%
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ---------------------------------- teams --------------------------------- */

export function TeamsPanel({
  orgSlug,
  teams,
  options,
  canManage,
}: {
  orgSlug: string
  teams: Array<{
    id: string
    name: string
    slug: string
    description: string | null
    department: { name: string } | null
    lead: { user: { name: string } } | null
    members: Array<{
      id: string
      role: string
      membershipId: string
      membership: { user: { name: string } }
    }>
  }>
  options: {
    members: Array<{ id: string; name: string }>
    departments: Array<{ id: string; name: string }>
  }
  canManage: boolean
}) {
  const [createState, createAction] = useActionState<FormState, FormData>(
    createTeamAction.bind(null, orgSlug),
    null,
  )
  const [addState, addAction] = useActionState<FormState, FormData>(
    addTeamMemberAction.bind(null, orgSlug),
    null,
  )
  const [, removeAction] = useActionState<FormState, FormData>(
    removeTeamMemberAction.bind(null, orgSlug),
    null,
  )

  const error = [createState, addState].find((state) => state && !state.ok) as
    Extract<FormState, { ok: false }> | undefined

  return (
    <div className="space-y-6">
      {error ? <Alert variant="destructive">{error.error.message}</Alert> : null}

      {teams.length === 0 ? (
        <p className="text-muted-foreground text-sm">No teams yet.</p>
      ) : (
        <ul className="space-y-4">
          {teams.map((team) => (
            <li key={team.id} className="bg-card space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="font-medium">{team.name}</h3>
                  <p className="text-muted-foreground text-xs">
                    {team.department?.name ?? 'No department'}
                    {team.lead ? ` · led by ${team.lead.user.name}` : ''}
                  </p>
                </div>
                <Badge variant="neutral">{team.members.length} members</Badge>
              </div>

              <ul className="flex flex-wrap gap-2">
                {team.members.map((member) => (
                  <li key={member.id} className="flex items-center gap-1">
                    <Badge variant={member.role === 'LEAD' ? 'default' : 'neutral'}>
                      {member.membership.user.name}
                    </Badge>
                    {canManage ? (
                      <form action={removeAction}>
                        <input type="hidden" name="teamId" value={team.id} />
                        <input type="hidden" name="membershipId" value={member.membershipId} />
                        <button
                          type="submit"
                          className="text-muted-foreground hover:text-destructive text-xs"
                          aria-label={`Remove ${member.membership.user.name} from ${team.name}`}
                        >
                          ×
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>

              {canManage ? (
                <form action={addAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="teamId" value={team.id} />
                  <SelectField
                    name="membershipId"
                    label="Add member"
                    placeholder="Choose…"
                    options={options.members
                      .filter((member) => !team.members.some((m) => m.membershipId === member.id))
                      .map((member) => ({ value: member.id, label: member.name }))}
                  />
                  <SelectField
                    name="role"
                    label="Role"
                    defaultValue="MEMBER"
                    options={TEAM_ROLES.map((value) => ({ value, label: titleCase(value) }))}
                  />
                  <Button type="submit" variant="outline" size="sm">
                    Add
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={createAction} className="bg-card space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-medium">New team</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="name" label="Name" required />
            <Field name="slug" label="Address" required hint="lowercase-with-hyphens" />
            <SelectField
              name="departmentId"
              label="Department"
              placeholder="None"
              options={options.departments.map((d) => ({ value: d.id, label: d.name }))}
            />
            <SelectField
              name="leadMembershipId"
              label="Lead"
              placeholder="None"
              options={options.members.map((m) => ({ value: m.id, label: m.name }))}
            />
          </div>
          <SubmitButton variant="outline" size="sm" pendingLabel="Creating…">
            Create team
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

/* ---------------------------- departments, skills ------------------------- */

export function DepartmentsPanel({
  orgSlug,
  departments,
  options,
  canManage,
}: {
  orgSlug: string
  departments: Array<{
    id: string
    name: string
    description: string | null
    head: { user: { name: string } } | null
    _count: { teams: number; profiles: number }
  }>
  options: { members: Array<{ id: string; name: string }> }
  canManage: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createDepartmentAction.bind(null, orgSlug),
    null,
  )

  return (
    <div className="space-y-4">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      {departments.length === 0 ? (
        <p className="text-muted-foreground text-sm">No departments yet.</p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {departments.map((department) => (
            <li key={department.id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <p className="font-medium">{department.name}</p>
                <p className="text-muted-foreground text-xs">
                  {department._count.profiles} people · {department._count.teams} teams
                  {department.head ? ` · headed by ${department.head.user.name}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={formAction} className="flex flex-wrap items-end gap-2 border-t pt-4">
          <Field name="name" label="New department" required className="min-w-48 flex-1" />
          <SelectField
            name="headMembershipId"
            label="Head"
            placeholder="None"
            options={options.members.map((m) => ({ value: m.id, label: m.name }))}
          />
          <SubmitButton variant="outline" size="sm" pendingLabel="Adding…">
            Add
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

export function SkillsPanel({
  orgSlug,
  skills,
  canManage,
}: {
  orgSlug: string
  skills: Array<{
    id: string
    name: string
    category: string | null
    _count: { memberships: number }
  }>
  canManage: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createSkillAction.bind(null, orgSlug),
    null,
  )

  return (
    <div className="space-y-4">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills recorded yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {skills.map((skill) => (
            <li key={skill.id}>
              <Badge variant="neutral">
                {skill.name} · {skill._count.memberships}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={formAction} className="flex flex-wrap items-end gap-2 border-t pt-4">
          <Field name="name" label="New skill" required className="min-w-40 flex-1" />
          <Field name="category" label="Category" className="min-w-32" />
          <SubmitButton variant="outline" size="sm" pendingLabel="Adding…">
            Add
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

export function MemberSkillsPanel({
  orgSlug,
  membershipId,
  skills,
  catalogue,
  canEdit,
}: {
  orgSlug: string
  membershipId: string
  skills: Array<{ id: string; name: string; level: number }>
  catalogue: Array<{ id: string; name: string }>
  canEdit: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    setMemberSkillAction.bind(null, orgSlug),
    null,
  )

  const held = new Set(skills.map((skill) => skill.id))
  const available = catalogue.filter((skill) => !held.has(skill.id))

  return (
    <div className="space-y-3">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills recorded.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {skills.map((skill) => (
            <li key={skill.id} className="flex items-center justify-between gap-3">
              <span>{skill.name}</span>
              <span className="text-muted-foreground tabular text-xs">{skill.level} / 5</span>
            </li>
          ))}
        </ul>
      )}

      {canEdit && available.length > 0 ? (
        <form action={formAction} className="flex flex-wrap items-end gap-2 border-t pt-3">
          <input type="hidden" name="membershipId" value={membershipId} />
          <SelectField
            name="skillId"
            label="Add skill"
            placeholder="Choose…"
            options={available.map((skill) => ({ value: skill.id, label: skill.name }))}
          />
          <Field
            name="level"
            label="Level"
            type="number"
            min={1}
            max={5}
            defaultValue="3"
            className="w-20"
          />
          <SubmitButton variant="outline" size="sm" pendingLabel="Adding…">
            Add
          </SubmitButton>
        </form>
      ) : null}
    </div>
  )
}

function toInput(amountMinor: bigint): string {
  const digits = (amountMinor < 0n ? -amountMinor : amountMinor).toString().padStart(3, '0')
  return `${amountMinor < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}
