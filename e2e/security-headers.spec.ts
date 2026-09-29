import { expect, test } from '@playwright/test'

/**
 * Security headers, and whether the policy actually holds.
 *
 * Asserting that a Content-Security-Policy header exists is the easy half and
 * the useless half — a policy that breaks the application gets weakened within
 * a day. So the second test drives a real page with a real form and fails on
 * any CSP violation the browser reports, which is the only way to know the
 * policy is both present and survivable.
 */

const PASSWORD = 'correct horse battery staple'

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

test.describe('security headers', () => {
  test('every document carries the policy, with a fresh nonce each time', async ({ page }) => {
    const first = await page.goto('/sign-in')
    const csp = first?.headers()['content-security-policy']

    expect(csp, 'no Content-Security-Policy on the sign-in page').toBeTruthy()

    // The parts that make it worth having.
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("'strict-dynamic'")

    // And the part that would quietly undo it.
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    expect(csp?.match(/script-src[^;]*/)?.[0]).not.toContain("'unsafe-inline'")

    const nonceOf = (value: string | undefined) => value?.match(/'nonce-([^']+)'/)?.[1]
    const firstNonce = nonceOf(csp)
    expect(firstNonce, 'the policy has no nonce, so it is not doing anything').toBeTruthy()

    const second = await page.goto('/sign-up')
    const secondNonce = nonceOf(second?.headers()['content-security-policy'])

    expect(secondNonce).toBeTruthy()
    expect(secondNonce, 'the nonce is reused across responses, which defeats it').not.toBe(
      firstNonce,
    )

    // The static headers, which the framework config sets.
    const headers = second?.headers() ?? {}
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['permissions-policy']).toContain('camera=()')
    // These tests run against a production build, which is the only place HSTS
    // is sent — `npm run dev` omits it so that a developer's browser is never
    // pinned to HTTPS on localhost.
    expect(headers['strict-transport-security']).toContain('max-age=')
    expect(headers['strict-transport-security']).toContain('includeSubDomains')
  })

  test('the application runs without violating its own policy', async ({ page }) => {
    const violations: string[] = []

    page.on('console', (message) => {
      const text = message.text()
      if (/content security policy|refused to (load|execute|apply)/i.test(text)) {
        violations.push(text)
      }
    })
    page.on('pageerror', (error) => {
      if (/content security policy/i.test(error.message)) violations.push(error.message)
    })

    // Signing up exercises the whole stack under the policy: hydration, a
    // Server Action, a redirect, and the authenticated shell.
    const email = `${unique('csp')}@example.test`
    const slug = unique('csp-org')

    await page.goto('/sign-up')
    await page.getByLabel('Name').fill('CSP Check')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.waitForURL('**/organizations/new')

    await page.getByLabel('Organization name').fill('CSP Ltd')
    await page.getByLabel('Web address').fill(slug)
    await page.getByRole('button', { name: 'Create organization' }).click()
    await page.waitForURL(`**/${slug}`)

    // A client component that only works once hydrated — proof the scripts the
    // policy allowed actually ran.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('CSP Ltd')
    await page.goto(`/${slug}/analytics`)
    await expect(page.getByRole('link', { name: '90 days' })).toBeVisible()

    expect(violations, `the page violated its own CSP:\n${violations.join('\n')}`).toEqual([])
  })
})

/**
 * Endpoints that authenticate themselves.
 *
 * The edge proxy turns an unauthenticated /api/* request into a 401 so that a
 * fetch fails rather than quietly receiving a sign-in page. That is right for
 * the endpoints a signed-in browser calls, and wrong for the four that no
 * browser calls: a payment webhook, a scheduler, a health probe and the API-key
 * surface all arrive without a cookie by definition.
 *
 * Each test below asserts the request reaches its handler — that the refusal,
 * where there is one, comes from the endpoint's own credential check and not
 * from the cookie check in front of it.
 */
test.describe('endpoints that carry their own credential', () => {
  test('the health check answers without a session', async ({ request }) => {
    const response = await request.get('/api/health')

    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } })
    expect(response.headers()['cache-control']).toContain('no-store')
  })

  test('the payment webhook is reached and refused on its signature', async ({ request }) => {
    const response = await request.post('/api/webhooks/billing', {
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      data: '{"id":"evt_forged","type":"customer.subscription.updated"}',
    })

    // Not 401: that would mean the proxy answered and the signature was never
    // checked. Whatever the handler decides, it decided it.
    expect(response.status()).not.toBe(401)
    expect(await response.text()).not.toContain('Sign in to continue')
  })

  test('the scheduled drain is reached and refused on its secret', async ({ request }) => {
    const response = await request.post('/api/cron/outbox')

    expect(response.status()).not.toBe(401)
    expect(await response.text()).not.toContain('Sign in to continue')
  })

  test('the API surface refuses a missing key itself', async ({ request }) => {
    const response = await request.get('/api/v1/projects')

    expect(response.status()).toBe(401)
    // The endpoint's own message, not the proxy's.
    expect(await response.text()).not.toContain('Sign in to continue')
  })
})

/**
 * Browser error reporting.
 *
 * Unauthenticated by design — the errors most worth hearing about happen on the
 * sign-in page — so the interesting assertions are about what it refuses.
 */
test.describe('the telemetry endpoint', () => {
  test('accepts a report without a session and answers 204', async ({ request }) => {
    const response = await request.post('/api/telemetry/error', {
      data: { kind: 'error', message: 'Something broke', path: '/sign-in' },
    })

    // 204 whether or not reporting is configured. Not 401: the proxy must not
    // be answering for this route.
    expect(response.status()).toBe(204)
    expect(await response.text()).not.toContain('Sign in to continue')
  })

  test('discards a malformed report quietly rather than describing the schema', async ({
    request,
  }) => {
    const responses = await Promise.all([
      request.post('/api/telemetry/error', { data: { kind: 'not-a-kind', message: 'x' } }),
      request.post('/api/telemetry/error', { data: { message: 'no kind' } }),
      request.post('/api/telemetry/error', { data: 'not even an object' }),
    ])

    for (const response of responses) {
      expect(response.status()).toBe(204)
      // A validation message here would turn the endpoint into a schema probe.
      expect(await response.text()).toBe('')
    }
  })

  test('refuses an oversized body', async ({ request }) => {
    const response = await request.post('/api/telemetry/error', {
      data: { kind: 'error', message: 'x'.repeat(200_000) },
    })

    // Either refused for size or discarded by the schema — never accepted whole.
    expect([204, 413]).toContain(response.status())
  })

  test('is not reachable by GET', async ({ request }) => {
    const response = await request.get('/api/telemetry/error')
    expect(response.status()).toBe(405)
  })
})
