import type { Metadata } from 'next'
import Link from 'next/link'

import { Alert } from '@/components/ui/alert'
import { AuthCard } from '@/modules/auth/components/auth-card'
import { VerifyEmailPanel } from '@/modules/auth/components/verify-email-panel'

export const metadata: Metadata = { title: 'Confirm your email' }

/**
 * Deliberately outside the (auth) route group: that group redirects anyone who
 * is already signed in, and confirming an address is something a signed-in user
 * does routinely.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

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
        <AuthCard title="Confirm your email address">
          {token ? (
            <VerifyEmailPanel token={token} />
          ) : (
            <Alert variant="destructive">
              This confirmation link is incomplete. Request a new one from your account page.
            </Alert>
          )}
        </AuthCard>
      </main>
    </div>
  )
}
