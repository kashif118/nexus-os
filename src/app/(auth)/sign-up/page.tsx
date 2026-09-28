import type { Metadata } from 'next'
import Link from 'next/link'

import { AuthCard } from '@/modules/auth/components/auth-card'
import { SignUpForm } from '@/modules/auth/components/sign-up-form'

export const metadata: Metadata = { title: 'Create account' }

export default function SignUpPage() {
  return (
    <AuthCard
      title="Create your account"
      description="Set up your NEXUS OS identity. Organizations come next."
      footer={
        <>
          Already registered?{' '}
          <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SignUpForm />
    </AuthCard>
  )
}
