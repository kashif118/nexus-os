import type { Metadata } from 'next'
import Link from 'next/link'

import { Alert } from '@/components/ui/alert'
import { AuthCard } from '@/modules/auth/components/auth-card'
import { ResetPasswordForm } from '@/modules/auth/components/reset-password-form'

export const metadata: Metadata = { title: 'Choose a new password' }

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  return (
    <AuthCard
      title="Choose a new password"
      footer={
        <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Alert variant="destructive">
          This reset link is incomplete. Request a new one from the sign-in page.
        </Alert>
      )}
    </AuthCard>
  )
}
