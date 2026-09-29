import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { headers } from 'next/headers'
import type { ReactNode } from 'react'

import { ClientErrorReporter } from '@/components/observability/client-error-reporter'
import { Toaster } from '@/components/feedback/toaster'
import { ThemeProvider } from '@/components/theme-provider'
import { clientEnv } from '@/kernel/config/env'
import '@/styles/globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'], display: 'swap' })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL(clientEnv.NEXT_PUBLIC_APP_URL),
  title: {
    default: `${clientEnv.NEXT_PUBLIC_APP_NAME} — Business Operating System`,
    template: `%s · ${clientEnv.NEXT_PUBLIC_APP_NAME}`,
  },
  description:
    'An AI-powered business operating system: work, money, people, clients and documents in one system, with an automation engine and permission-scoped AI agents.',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfc' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1d22' },
  ],
}

/**
 * The root layout.
 *
 * It reads the request headers for the CSP nonce, which makes it dynamic. That
 * is a deliberate trade: next-themes writes an inline script to set the theme
 * before first paint, and under a nonce-based policy an un-nonced inline script
 * is blocked — losing the script means a flash of the wrong theme on every load.
 * Every page in the product is already rendered per request because every page
 * is tenant data, so the only page this costs anything is the signed-out
 * landing page.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans`}>
        <ThemeProvider
          nonce={nonce}
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          <ClientErrorReporter />
        </ThemeProvider>
      </body>
    </html>
  )
}
