import type { Metadata } from 'next'
import Link from 'next/link'

import { Alert } from '@/components/ui/alert'
import { requireUserPage } from '@/kernel/auth/guards'
import { isAppError } from '@/kernel/errors'
import { AuthCard } from '@/modules/auth/components/auth-card'
import { AcceptInvitationForm } from '@/modules/organizations/components/accept-invitation-form'
import { previewInvitation } from '@/modules/organizations/queries'

export const metadata: Metadata = { title: 'Join organization' }

/**
 * Invitation acceptance.
 *
 * The page previews without redeeming, so a mail scanner following the link
 * cannot consume the invitation. Redemption happens on an explicit submit.
 *
 * Signing in is required first: an invitation is bound to the address it was
 * sent to, and joining must attach to a real identity.
 */
export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const session = await requireUserPage(`/invitations/${token}`)

  let preview: Awaited<ReturnType<typeof previewInvitation>> | null = null
  let problem: string | null = null

  try {
    preview = await previewInvitation(decodeURIComponent(token), session.user.email)
  } catch (error) {
    problem = isAppError(error) ? error.message : 'That invitation link is not valid.'
  }

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

      <main className="w-full max-w-sm">
        <AuthCard
          title={preview ? `Join ${preview.organizationName}` : 'Invitation'}
          description={preview ? `Invited as ${preview.email}.` : undefined}
          footer={
            <Link href="/account" className="text-foreground underline-offset-4 hover:underline">
              Back to your account
            </Link>
          }
        >
          {problem ? (
            <Alert variant="destructive">{problem}</Alert>
          ) : (
            <AcceptInvitationForm token={decodeURIComponent(token)} />
          )}
        </AuthCard>
      </main>
    </div>
  )
}
