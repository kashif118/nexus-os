import type { Ctx } from '@/kernel/tenancy/ctx'
import { containsInsensitive } from '@/kernel/validation/list-params'

/**
 * People data access.
 *
 * Note that `employeeProfile` is selected WITH its sensitive columns here and
 * redacted in the service. That is deliberate: redaction lives in exactly one
 * function rather than being duplicated across every query, so there is one
 * place to audit.
 */

export async function listPeople(ctx: Ctx, search?: string) {
  return ctx.db.membership.findMany({
    where: {
      status: { in: ['ACTIVE', 'SUSPENDED'] },
      ...(search
        ? {
            OR: [
              { user: { name: containsInsensitive(search) } },
              { user: { email: containsInsensitive(search) } },
              { title: containsInsensitive(search) },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      status: true,
      user: { select: { id: true, name: true, email: true, image: true } },
      employeeProfile: {
        select: {
          position: true,
          employmentType: true,
          weeklyCapacityMinutes: true,
          costRateMinor: true,
          billRateMinor: true,
          currency: true,
          department: { select: { id: true, name: true } },
        },
      },
      skills: { select: { level: true, skill: { select: { id: true, name: true } } } },
    },
  })
}

export async function findPerson(ctx: Ctx, membershipId: string) {
  return ctx.db.membership.findFirst({
    where: { id: membershipId },
    select: {
      id: true,
      title: true,
      status: true,
      joinedAt: true,
      user: { select: { id: true, name: true, email: true, image: true } },
      employeeProfile: {
        select: {
          position: true,
          employmentType: true,
          hireDate: true,
          location: true,
          weeklyCapacityMinutes: true,
          departmentId: true,
          managerMembershipId: true,
          costRateMinor: true,
          billRateMinor: true,
          currency: true,
          department: { select: { id: true, name: true } },
        },
      },
      skills: { select: { level: true, skill: { select: { id: true, name: true } } } },
    },
  })
}

export async function findMembership(ctx: Ctx, membershipId: string) {
  return ctx.db.membership.findFirst({
    where: { id: membershipId, status: 'ACTIVE' },
    select: { id: true },
  })
}

export async function listMemberOptions(ctx: Ctx) {
  const rows = await ctx.db.membership.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    take: 300,
    select: { id: true, user: { select: { name: true } } },
  })
  return rows.map((row) => ({ id: row.id, name: row.user.name }))
}

export async function upsertProfile(ctx: Ctx, data: Record<string, unknown>) {
  const { membershipId, ...rest } = data as { membershipId: string } & Record<string, unknown>

  return ctx.db.employeeProfile.upsert({
    where: { membershipId },
    create: { organizationId: ctx.orgId, membershipId, ...rest } as never,
    update: rest as never,
    select: { id: true },
  })
}

/* --------------------------------- teams ---------------------------------- */

export async function listTeams(ctx: Ctx) {
  return ctx.db.team.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      department: { select: { id: true, name: true } },
      lead: { select: { id: true, user: { select: { name: true } } } },
      members: {
        select: {
          id: true,
          role: true,
          membershipId: true,
          membership: { select: { user: { select: { name: true } } } },
        },
      },
    },
  })
}

export async function findTeam(ctx: Ctx, id: string) {
  return ctx.db.team.findFirst({ where: { id }, select: { id: true, name: true } })
}

export async function findTeamBySlug(ctx: Ctx, slug: string) {
  return ctx.db.team.findFirst({ where: { slug }, select: { id: true } })
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
) {
  return ctx.db.team.create({
    data: {
      organizationId: ctx.orgId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      departmentId: input.departmentId ?? null,
      leadMembershipId: input.leadMembershipId ?? null,
    },
    select: { id: true },
  })
}

export async function addTeamMember(
  ctx: Ctx,
  input: { teamId: string; membershipId: string; role: string },
) {
  return ctx.db.teamMember.upsert({
    where: { teamId_membershipId: { teamId: input.teamId, membershipId: input.membershipId } },
    create: {
      organizationId: ctx.orgId,
      teamId: input.teamId,
      membershipId: input.membershipId,
      role: input.role as never,
    },
    update: { role: input.role as never },
    select: { id: true },
  })
}

export async function removeTeamMember(ctx: Ctx, input: { teamId: string; membershipId: string }) {
  const result = await ctx.db.teamMember.deleteMany({ where: input })
  return result.count
}

export async function teamsFor(ctx: Ctx, membershipId: string) {
  const rows = await ctx.db.teamMember.findMany({
    where: { membershipId },
    select: { role: true, team: { select: { id: true, name: true, slug: true } } },
  })
  return rows.map((row) => ({ ...row.team, role: row.role }))
}

/* ------------------------------ departments ------------------------------- */

export async function listDepartments(ctx: Ctx) {
  return ctx.db.department.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      parentId: true,
      head: { select: { id: true, user: { select: { name: true } } } },
      _count: { select: { teams: true, profiles: true } },
    },
  })
}

export async function findDepartment(ctx: Ctx, id: string) {
  return ctx.db.department.findFirst({ where: { id }, select: { id: true } })
}

export async function createDepartment(
  ctx: Ctx,
  input: {
    name: string
    description?: string | undefined
    parentId?: string | undefined
    headMembershipId?: string | undefined
  },
) {
  return ctx.db.department.create({
    data: {
      organizationId: ctx.orgId,
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      headMembershipId: input.headMembershipId ?? null,
    },
    select: { id: true },
  })
}

/* --------------------------------- skills --------------------------------- */

export async function listSkills(ctx: Ctx) {
  return ctx.db.skill.findMany({
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, category: true, _count: { select: { memberships: true } } },
  })
}

export async function findSkill(ctx: Ctx, id: string) {
  return ctx.db.skill.findFirst({ where: { id }, select: { id: true } })
}

export async function createSkill(
  ctx: Ctx,
  input: { name: string; category?: string | undefined },
) {
  return ctx.db.skill.create({
    data: { organizationId: ctx.orgId, name: input.name, category: input.category ?? null },
    select: { id: true },
  })
}

export async function setMemberSkill(
  ctx: Ctx,
  input: { membershipId: string; skillId: string; level: number },
) {
  return ctx.db.membershipSkill.upsert({
    where: {
      membershipId_skillId: { membershipId: input.membershipId, skillId: input.skillId },
    },
    create: { organizationId: ctx.orgId, ...input },
    update: { level: input.level },
    select: { id: true },
  })
}

export async function removeMemberSkill(
  ctx: Ctx,
  input: { membershipId: string; skillId: string },
) {
  await ctx.db.membershipSkill.deleteMany({ where: input })
}

/* -------------------------------- workload -------------------------------- */

export async function projectsFor(ctx: Ctx, membershipId: string) {
  return ctx.db.project.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ['ARCHIVED'] },
      OR: [{ managerMembershipId: membershipId }, { members: { some: { membershipId } } }],
    },
    orderBy: { dueDate: 'asc' },
    select: { id: true, key: true, name: true, status: true, healthStatus: true, dueDate: true },
  })
}

export async function workloadFor(ctx: Ctx, membershipId: string) {
  const [openTasks, overdueTasks, estimate] = await Promise.all([
    ctx.db.task.count({
      where: {
        deletedAt: null,
        assigneeMembershipId: membershipId,
        status: { notIn: ['DONE', 'CANCELLED'] },
      },
    }),
    ctx.db.task.count({
      where: {
        deletedAt: null,
        assigneeMembershipId: membershipId,
        status: { notIn: ['DONE', 'CANCELLED'] },
        dueDate: { lt: new Date() },
      },
    }),
    ctx.db.task.aggregate({
      where: {
        deletedAt: null,
        assigneeMembershipId: membershipId,
        status: { notIn: ['DONE', 'CANCELLED'] },
      },
      _sum: { estimateMinutes: true },
    }),
  ])

  return { openTasks, overdueTasks, estimatedMinutes: estimate._sum.estimateMinutes ?? 0 }
}

/**
 * Open load per member, in three grouped queries rather than N per person.
 */
export async function workloadByMembership(ctx: Ctx) {
  const openFilter = {
    deletedAt: null,
    status: { notIn: ['DONE', 'CANCELLED'] as never },
    assigneeMembershipId: { not: null },
  }

  const [open, overdue, projects] = await Promise.all([
    ctx.db.task.groupBy({
      by: ['assigneeMembershipId'],
      where: openFilter,
      _count: { _all: true },
      _sum: { estimateMinutes: true },
    }),
    ctx.db.task.groupBy({
      by: ['assigneeMembershipId'],
      where: { ...openFilter, dueDate: { lt: new Date() } },
      _count: { _all: true },
    }),
    ctx.db.projectMember.groupBy({ by: ['membershipId'], _count: { _all: true } }),
  ])

  const overdueByMember = new Map(overdue.map((row) => [row.assigneeMembershipId, row._count._all]))
  const projectsByMember = new Map(projects.map((row) => [row.membershipId, row._count._all]))

  return open
    .filter((row): row is typeof row & { assigneeMembershipId: string } =>
      Boolean(row.assigneeMembershipId),
    )
    .map((row) => ({
      membershipId: row.assigneeMembershipId,
      openTasks: row._count._all,
      estimatedMinutes: row._sum.estimateMinutes ?? 0,
      overdueTasks: overdueByMember.get(row.assigneeMembershipId) ?? 0,
      projects: projectsByMember.get(row.assigneeMembershipId) ?? 0,
    }))
}

/** Open assigned tasks with no estimate — the honesty caveat on utilisation. */
export async function countUnestimatedOpenTasks(ctx: Ctx): Promise<number> {
  return ctx.db.task.count({
    where: {
      deletedAt: null,
      status: { notIn: ['DONE', 'CANCELLED'] },
      assigneeMembershipId: { not: null },
      estimateMinutes: null,
    },
  })
}
