import type { Metadata } from 'next'

import { PageHeader } from '@/components/feedback/states'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { DepartmentsPanel, SkillsPanel, TeamsPanel } from '@/modules/people/components/people-ui'
import {
  getPeopleFormOptions,
  listDepartments,
  listSkills,
  listTeams,
} from '@/modules/people/queries'

export const metadata: Metadata = { title: 'Teams' }

export default async function TeamsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await requireCtxPage(orgSlug)

  const [teams, departments, skills, options] = await Promise.all([
    listTeams(ctx),
    listDepartments(ctx),
    listSkills(ctx),
    getPeopleFormOptions(ctx),
  ])

  return (
    <div className="space-y-6">
      <PageHeader title="Teams" description="How the organization is grouped." />

      <TeamsPanel
        orgSlug={orgSlug}
        teams={teams}
        options={options}
        canManage={ctx.can('people.team.manage')}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Departments</CardTitle>
          </CardHeader>
          <CardContent>
            <DepartmentsPanel
              orgSlug={orgSlug}
              departments={departments}
              options={options}
              canManage={ctx.can('people.department.manage')}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
          </CardHeader>
          <CardContent>
            <SkillsPanel
              orgSlug={orgSlug}
              skills={skills}
              canManage={ctx.can('people.skill.manage')}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
