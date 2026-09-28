import type { Metadata } from 'next'
import Link from 'next/link'

import { safeRedirectPath } from '@/kernel/auth/guards'
import { AuthCard } from '@/modules/auth/components/auth-card'
import { SignInForm } from '@/modules/auth/components/sign-in-form'

export const metadata: Metadata = { title: 'Sign in' }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  // Validated here as well as on submit: never echo an unchecked URL back into
  // the page (docs/OPERATIONS.md §N.1, open-redirect prevention).
  const safeNext = next ? safeRedirectPath(next) : undefined

  return (
    <AuthCard
      title="Sign in"
      description="Welcome back."
      footer={
        <>
          No account?{' '}
          <Link href="/sign-up" className="text-foreground underline-offset-4 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <SignInForm next={safeNext} />
    </AuthCard>
  )
}
