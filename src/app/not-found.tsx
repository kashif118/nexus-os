import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md space-y-4 text-center">
        <p className="text-muted-foreground font-mono text-sm">404</p>
        <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-muted-foreground text-sm">
          This page does not exist, or you do not have access to it.
        </p>
        <Link href="/" className={buttonVariants({ variant: 'outline' })}>
          Back to start
        </Link>
      </div>
    </main>
  )
}
