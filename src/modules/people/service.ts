import { writeAuditLog } from '@/kernel/audit/write'
import { conflict, notFound, validationError } from '@/kernel/errors'
import type { Ctx } from '@/kernel/tenancy/ctx'

import * as repository from './repository'

/**
 * People, teams and workload.
 *
 * The rule that shapes this module: **sensitive profile fields are redacted in
 * the SERVICE, not hidden in the UI.** A Manager can see who is on a team and
 * how loaded they are, but pay rates leave the service as `null` unless the
 * caller holds `people.profile.read.sensitive`. A field that never leaves the
 * server cannot leak through a serialised prop or a cached payload.
 */

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

export interface PersonSummary {
  membershipId: string
  name: string
  email: string
  title: string | null
  position: string | null
  employmentType: string | null
  departmentName: string | null
  weeklyCapacityMinutes: number
  /** Null unless the caller may see sensitive fields. */
  costRateMinor: bigint | null
  billRateMinor: bigint | null
  currency: string | null
  skills: Array<{ id: string; name: string; level: number }>
}

/**
 * Strip sensitive fields unless the caller holds the permission.
 *
 * Applied at every read path, so there is one place to audit.
 */
function redactProfile(
  ctx: Ctx,
  profile: {
    costRateMinor: bigint | null
    billRateMinor: bigint | null
    currency: string | null
  } | null,
): { costRateMinor: bigint | null; billRateMinor: bigint | null; currency: string | null } {
  if (!profile) return { costRateMinor: null, billRateMinor: null, currency: null }
  if (!ctx.can('people.profile.read.sensitive')) {
    return { costRateMinor: null, billRateMinor: null, currency: null }
  }
  return profile
}

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

export async function listPeople(ctx: Ctx, search?: string): Promise<PersonSummary[]> {
  ctx.require('people.read')

  const rows = await repository.listPeople(ctx, search)

  return rows.map((row) => {
    const sensitive = redactProfile(ctx, row.employeeProfile)
    return {
      membershipId: row.id,
      name: row.user.name,
      email: row.user.email,
      title: row.title,
      position: row.employeeProfile?.position ?? null,
      employmentType: row.employeeProfile?.employmentType ?? null,
      departmentName: row.employeeProfile?.department?.name ?? null,
      weeklyCapacityMinutes: row.employeeProfile?.weeklyCapacityMinutes ?? 2400,
      ...sensitive,
      skills: row.skills.map((entry) => ({
        id: entry.skill.id,
        name: entry.skill.name,
        level: entry.level,
      })),
    }
  })
}

export async function getPerson(ctx: Ctx, membershipId: string) {
  ctx.require('people.read')

  const person = await repository.findPerson(ctx, membershipId)
  if (!person) throw notFound('That person is not available.')

  const [projects, workload, teams] = await Promise.all([
    repository.projectsFor(ctx, membershipId),
    repository.workloadFor(ctx, membershipId),
    repository.teamsFor(ctx, membershipId),
  ])

  const sensitive = redactProfile(ctx, person.employeeProfile)

  return {
    membershipId: person.id,
    name: person.user.name,
    email: person.user.email,
    title: person.title,
    status: person.status,
    joinedAt: person.joinedAt,
    profile: person.employeeProfile
      ? {
          position: person.employeeProfile.position,
          employmentType: person.employeeProfile.employmentType,
          hireDate: person.employeeProfile.hireDate,
          location: person.employeeProfile.location,
          weeklyCapacityMinutes: person.employeeProfile.weeklyCapacityMinutes,
          departmentId: person.employeeProfile.departmentId,
          departmentName: person.employeeProfile.department?.name ?? null,
          managerMembershipId: person.employeeProfile.managerMembershipId,
          ...sensitive,
        }
      : null,
    skills: person.skills.map((entry) => ({
      id: entry.skill.id,
      name: entry.skill.name,
      level: entry.level,
    })),
    projects,
    teams,
    workload,
    /** Tells the UI whether the blanks are "not set" or "not visible to you". */
    canSeeSensitive: ctx.can('people.profile.read.sensitive'),
  }
}

export async function upsertProfile(
  ctx: Ctx,
  input: {
    membershipId: string
    position?: string | undefined
    employmentType: string
    departmentId?: string | undefined
    hireDate?: Date | undefined
    location?: string | undefined
    weeklyCapacityMinutes: number
    costRateMinor?: bigint | undefined
    billRateMinor?: bigint | undefined
    managerMembershipId?: string | undefined
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('people.profile.manage')

  const membership = await repository.findMembership(ctx, input.membershipId)
  if (!membership) throw notFound('That person is not a member of this organization.')

  if (input.managerMembershipId) {
    if (input.managerMembershipId === input.membershipId) {
      throw validationError('Someone cannot manage themselves.', {
        managerMembershipId: ['Choose a different person.'],
      })
    }
    const manager = await repository.findMembership(ctx, input.managerMembershipId)
    if (!manager) throw validationError('That manager is not a member of this organization.')
  }

  if (input.departmentId) {
    const department = await repository.findDepartment(ctx, input.departmentId)
    if (!department) throw validationError('That department is not available.')
  }

  // Pay rates require the sensitive permission on top of profile.manage: an HR
  // admin who may edit a position is not necessarily trusted with pay.
  const rateFields = ctx.can('people.profile.read.sensitive')
    ? {
        costRateMinor: input.costRateMinor ?? null,
        billRateMinor: input.billRateMinor ?? null,
        currency: ctx.org.currency,
      }
    : {}

  await repository.upsertProfile(ctx, {
    membershipId: input.membershipId,
    position: input.position ?? null,
    employmentType: input.employmentType,
    departmentId: input.departmentId ?? null,
    hireDate: input.hireDate ?? null,
    location: input.location ?? null,
    weeklyCapacityMinutes: input.weeklyCapacityMinutes,
    managerMembershipId: input.managerMembershipId ?? null,
    ...rateFields,
  })

  await writeAuditLog({
    action: 'people.profile_updated',
    entityType: 'Membership',
    entityId: input.membershipId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    // The values are deliberately NOT recorded: an audit log that copies pay
    // rates just moves the sensitive data somewhere with weaker permissions.
    metadata: { ratesChanged: Object.keys(rateFields).length > 0 },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Teams and departments                                                       */
/* -------------------------------------------------------------------------- */

export async function listTeams(ctx: Ctx) {
  ctx.require('people.read')
  return repository.listTeams(ctx)
}

export async function createTeam(
  ctx: Ctx,
  input: {
    name: string
    slug: string
    description?: string | undefined
    departmentId?: string | undefined
    leadMembershipId?: string | undefined
  },
  meta: RequestMeta,
): Promise<{ id: string }> {
  ctx.require('people.team.manage')

  const existing = await repository.findTeamBySlug(ctx, input.slug)
  if (existing) {
    throw conflict('A team with that address already exists.', { slug: ['Already in use.'] })
  }

  const team = await repository.createTeam(ctx, input)

  // The lead is a member by definition.
  if (input.leadMembershipId) {
    await repository.addTeamMember(ctx, {
      teamId: team.id,
      membershipId: input.leadMembershipId,
      role: 'LEAD',
    })
  }

  await writeAuditLog({
    action: 'people.team_created',
    entityType: 'Team',
    entityId: team.id,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { name: input.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return { id: team.id }
}

export async function addTeamMember(
  ctx: Ctx,
  input: { teamId: string; membershipId: string; role: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('people.team.manage')

  const [team, membership] = await Promise.all([
    repository.findTeam(ctx, input.teamId),
    repository.findMembership(ctx, input.membershipId),
  ])
  if (!team) throw notFound('That team is not available.')
  if (!membership) throw validationError('That person is not a member of this organization.')

  await repository.addTeamMember(ctx, input)

  await writeAuditLog({
    action: 'people.team_member_added',
    entityType: 'Team',
    entityId: input.teamId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function removeTeamMember(
  ctx: Ctx,
  input: { teamId: string; membershipId: string },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('people.team.manage')

  const removed = await repository.removeTeamMember(ctx, input)
  if (removed === 0) throw notFound('That person is not on this team.')

  await writeAuditLog({
    action: 'people.team_member_removed',
    entityType: 'Team',
    entityId: input.teamId,
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

export async function listDepartments(ctx: Ctx) {
  ctx.require('people.read')
  return repository.listDepartments(ctx)
}

export async function createDepartment(
  ctx: Ctx,
  input: {
    name: string
    description?: string | undefined
    parentId?: string | undefined
    headMembershipId?: string | undefined
  },
  meta: RequestMeta,
): Promise<void> {
  ctx.require('people.department.manage')

  try {
    await repository.createDepartment(ctx, input)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('A department with that name already exists.', { name: ['Already in use.'] })
    }
    throw error
  }

  await writeAuditLog({
    action: 'people.department_created',
    entityType: 'Department',
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    metadata: { name: input.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                      */
/* -------------------------------------------------------------------------- */

export async function listSkills(ctx: Ctx) {
  ctx.require('people.read')
  return repository.listSkills(ctx)
}

export async function createSkill(
  ctx: Ctx,
  input: { name: string; category?: string | undefined },
): Promise<void> {
  ctx.require('people.skill.manage')

  try {
    await repository.createSkill(ctx, input)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('That skill already exists.', { name: ['Already in the catalogue.'] })
    }
    throw error
  }
}

export async function setMemberSkill(
  ctx: Ctx,
  input: { membershipId: string; skillId: string; level: number },
): Promise<void> {
  // Editing someone else's skills is a profile change; editing your own is not.
  if (input.membershipId !== ctx.membershipId) ctx.require('people.profile.manage')

  const skill = await repository.findSkill(ctx, input.skillId)
  if (!skill) throw notFound('That skill is not available.')

  await repository.setMemberSkill(ctx, input)
}

export async function removeMemberSkill(
  ctx: Ctx,
  input: { membershipId: string; skillId: string },
): Promise<void> {
  if (input.membershipId !== ctx.membershipId) ctx.require('people.profile.manage')
  await repository.removeMemberSkill(ctx, input)
}

/* -------------------------------------------------------------------------- */
/* Workload                                                                    */
/* -------------------------------------------------------------------------- */

export interface WorkloadRow {
  membershipId: string
  name: string
  openTasks: number
  overdueTasks: number
  estimatedMinutes: number
  capacityMinutes: number
  /** Estimated load as a percentage of weekly capacity. */
  utilisationPercent: number
  projects: number
}

/**
 * Team workload.
 *
 * Utilisation is estimate-driven: it only counts tasks that carry an estimate,
 * because inferring effort from a task with no estimate would invent data. The
 * UI says how many tasks are unestimated so the number can be read honestly.
 */
export async function getWorkload(ctx: Ctx): Promise<{
  rows: WorkloadRow[]
  unestimatedTasks: number
}> {
  ctx.require('people.workload.view')

  const [people, load, unestimated] = await Promise.all([
    repository.listPeople(ctx),
    repository.workloadByMembership(ctx),
    repository.countUnestimatedOpenTasks(ctx),
  ])

  const loadByMembership = new Map(load.map((row) => [row.membershipId, row]))

  const rows = people.map((person) => {
    const entry = loadByMembership.get(person.id)
    const capacity = person.employeeProfile?.weeklyCapacityMinutes ?? 2400
    const estimated = entry?.estimatedMinutes ?? 0

    return {
      membershipId: person.id,
      name: person.user.name,
      openTasks: entry?.openTasks ?? 0,
      overdueTasks: entry?.overdueTasks ?? 0,
      estimatedMinutes: estimated,
      capacityMinutes: capacity,
      utilisationPercent: capacity > 0 ? Math.round((estimated / capacity) * 100) : 0,
      projects: entry?.projects ?? 0,
    }
  })

  rows.sort((a, b) => b.utilisationPercent - a.utilisationPercent)

  return { rows, unestimatedTasks: unestimated }
}

export async function getPeopleFormOptions(ctx: Ctx) {
  const [members, departments, skills] = await Promise.all([
    repository.listMemberOptions(ctx),
    repository.listDepartments(ctx),
    repository.listSkills(ctx),
  ])
  return { members, departments, skills }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
