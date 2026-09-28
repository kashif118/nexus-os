import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUserPage } from '@/kernel/auth/guards'
import { AuthCard } from '@/modules/auth/components/auth-card'
import { CreateOrganizationForm } from '@/modules/organizations/components/create-organization-form'

export const metadata: Metadata = { title: 'New organization' }

export default async function NewOrganizationPage() {
  await requireUserPage('/organizations/new')

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 py-12">
      <Link href="/" className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg font-mono text-sm font-bold"
        >
          N
        </span>
        <span className="font-semibold tracking-tight">NEXUS OS</span>
      </Link>

      <main className="w-full max-w-md">
        <AuthCard
          title="Create an organization"
          description="Everything in NEXUS OS belongs to an organization. You can create more later and switch between them."
        >
          <CreateOrganizationForm />
        </AuthCard>
      </main>
    </div>
  )
}
