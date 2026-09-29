import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/feedback/states'
import { initialsOf } from '@/lib/format'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { isAppError } from '@/kernel/errors'
import { requireCtxPage } from '@/kernel/tenancy/ctx'
import { MemberSkillsPanel, ProfileForm, RatePanel } from '@/modules/people/components/people-ui'
import { getPeopleFormOptions, getPerson } from '@/modules/people/queries'

export const metadata: Metadata = { title: 'Person' }

export default async function PersonPage({
  params,
}: {
  params: Promise<{ orgSlug: string; membershipId: string }>
}) {
  const { orgSlug, membershipId } = await params
  const ctx = await requireCtxPage(orgSlug)

  let person: Awaited<ReturnType<typeof getPerson>>
  try {
    person = await getPerson(ctx, membershipId)
  } catch (error) {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  }

  const options = await getPeopleFormOptions(ctx)
  const canManage = ctx.can('people.profile.manage')
  const isSelf = person.membershipId === ctx.membershipId

  return (
    <div className="space-y-6">
      <PageHeader
        title={person.name}
        description={person.profile?.position ?? person.title ?? person.email}
        actions={
          <Avatar className="size-10">
            <AvatarFallback>{initialsOf(person.name)}</AvatarFallback>
          </Avatar>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {canManage ? (
            <Card>
              <CardHeader>
                <CardTitle>Profile</CardTitle>
              </CardHeader>
              <CardContent>
                <ProfileForm
                  orgSlug={orgSlug}
                  membershipId={person.membershipId}
                  options={options}
                  currency={ctx.org.currency}
                  canSeeSensitive={person.canSeeSensitive}
                  profile={person.profile}
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="Email" value={person.email} />
                {person.profile?.position ? (
                  <Row label="Position" value={person.profile.position} />
                ) : null}
                {person.profile?.departmentName ? (
                  <Row label="Department" value={person.profile.departmentName} />
                ) : null}
                {person.profile?.location ? (
                  <Row label="Location" value={person.profile.location} />
                ) : null}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Projects ({person.projects.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {person.projects.length === 0 ? (
                <p className="text-muted-foreground text-sm">Not on any project.</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {person.projects.map((project) => (
                    <li key={project.id} className="flex items-center justify-between gap-3 py-2">
                      <Link
                        href={`/${orgSlug}/projects/${project.id}`}
                        className="truncate font-medium hover:underline"
                      >
                        <span className="text-muted-foreground font-mono text-xs">
                          {project.key}
                        </span>{' '}
                        {project.name}
                      </Link>
                      <Badge
                        variant={
                          project.healthStatus === 'CRITICAL'
                            ? 'destructive'
                            : project.healthStatus === 'AT_RISK'
                              ? 'warning'
                              : 'success'
                        }
                      >
                        {project.healthStatus.charAt(0) +
                          project.healthStatus.slice(1).toLowerCase().replace(/_/g, ' ')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Current load</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Open tasks" value={String(person.workload.openTasks)} />
              <Row label="Overdue" value={String(person.workload.overdueTasks)} />
              <Row
                label="Estimated"
                value={`${Math.round(person.workload.estimatedMinutes / 60)} h`}
              />
              {person.profile ? (
                <Row
                  label="Capacity"
                  value={`${Math.round(person.profile.weeklyCapacityMinutes / 60)} h / week`}
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Rates</CardTitle>
            </CardHeader>
            <CardContent>
              <RatePanel
                costRateMinor={person.profile?.costRateMinor ?? null}
                billRateMinor={person.profile?.billRateMinor ?? null}
                currency={ctx.org.currency}
                canSeeSensitive={person.canSeeSensitive}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Skills</CardTitle>
            </CardHeader>
            <CardContent>
              <MemberSkillsPanel
                orgSlug={orgSlug}
                membershipId={person.membershipId}
                skills={person.skills}
                catalogue={options.skills}
                canEdit={canManage || isSelf}
              />
            </CardContent>
          </Card>

          {person.teams.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Teams</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-wrap gap-1.5">
                  {person.teams.map((team) => (
                    <li key={team.id}>
                      <Badge variant={team.role === 'LEAD' ? 'default' : 'neutral'}>
                        {team.name}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
