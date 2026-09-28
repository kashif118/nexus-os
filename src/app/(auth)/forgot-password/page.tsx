import type { Metadata } from 'next'
import Link from 'next/link'

import { AuthCard } from '@/modules/auth/components/auth-card'
import { ForgotPasswordForm } from '@/modules/auth/components/forgot-password-form'

export const metadata: Metadata = { title: 'Reset password' }

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a link to choose a new one."
      footer={
        <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthCard>
  )
}
