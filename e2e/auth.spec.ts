import { expect, test, type Page } from '@playwright/test'

/**
 * End-to-end authentication flows (docs/OPERATIONS.md §O.2).
 *
 * These run against a real PostgreSQL database and the production build, so they
 * exercise the genuine session lifecycle: cookie issuance, database lookup,
 * revocation and route protection.
 */

const PASSWORD = 'correct horse battery staple'

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
}

/**
 * Register, then land on the account page.
 *
 * A brand-new account belongs to no organization, so sign-up sends the user to
 * organization creation (Phase 03). These tests are about identity rather than
 * tenancy, so they step straight to /account afterwards.
 */
async function signUp(page: Page, email: string, name = 'Ada Lovelace') {
  await page.goto('/sign-up')
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/organizations/new')
  await page.goto('/account')
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.describe('registration', () => {
  test('creates an account and signs the user in', async ({ page }) => {
    const email = uniqueEmail('signup')
    await signUp(page, email)

    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
    await expect(page.getByText(email).first()).toBeVisible()
  })

  test('marks a new account as unconfirmed', async ({ page }) => {
    await signUp(page, uniqueEmail('unconfirmed'))
    await expect(page.getByText('Unconfirmed').first()).toBeVisible()
  })

  test('rejects a duplicate email address', async ({ page }) => {
    const email = uniqueEmail('duplicate')
    await signUp(page, email)

    await page.goto('/account')
    await page.getByRole('button', { name: 'Sign out' }).first().click()
    await page.waitForURL('**/sign-in')

    await page.goto('/sign-up')
    await page.getByLabel('Name').fill('Someone Else')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page.getByText(/already exists/i)).toBeVisible()
  })

  test('enforces the password policy server-side', async ({ page }) => {
    await page.goto('/sign-up')
    await page.getByLabel('Name').fill('Ada')
    await page.getByLabel('Email').fill(uniqueEmail('weak'))
    await page.getByLabel('Password').fill('short')
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page.locator('#password-error')).toContainText(/at least 12 characters/i)
    await expect(page).toHaveURL(/sign-up/)
  })

  test('rejects a malformed email address', async ({ page }) => {
    await page.goto('/sign-up')
    await page.getByLabel('Name').fill('Ada')
    await page.getByLabel('Email').fill('not-an-email')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page.getByText(/valid email address/i)).toBeVisible()
  })
})

test.describe('sign in and sign out', () => {
  test('signs in with correct credentials', async ({ page, context }) => {
    const email = uniqueEmail('signin')
    await signUp(page, email)
    await context.clearCookies()

    await signIn(page, email)
    // With no organization yet, sign-in lands on onboarding.
    await page.waitForURL('**/organizations/new')

    await page.goto('/account')
    await expect(page.getByText(email).first()).toBeVisible()
  })

  test('rejects a wrong password without revealing that the account exists', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('wrongpass')
    await signUp(page, email)
    await context.clearCookies()

    await signIn(page, email, 'a-completely-wrong-password')
    const knownAccountMessage = await page.getByRole('status').textContent()

    await signIn(page, uniqueEmail('never-registered'), 'a-completely-wrong-password')
    const unknownAccountMessage = await page.getByRole('status').textContent()

    expect(knownAccountMessage).toBe(unknownAccountMessage)
    expect(knownAccountMessage).toMatch(/not correct/i)
  })

  test('signs out and drops access to protected pages', async ({ page }) => {
    await signUp(page, uniqueEmail('signout'))

    await page.getByRole('button', { name: 'Sign out' }).first().click()
    await page.waitForURL('**/sign-in')

    await page.goto('/account')
    await expect(page).toHaveURL(/sign-in/)
  })

  test('sets an httpOnly session cookie', async ({ page, context }) => {
    await signUp(page, uniqueEmail('cookie'))

    const cookie = (await context.cookies()).find((item) => item.name.includes('nexus_session'))
    expect(cookie).toBeDefined()
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('Lax')
    // The cookie must be an opaque token, not a JWT carrying claims.
    expect(cookie?.value.split('.').length).toBe(1)
  })
})

test.describe('protected routes', () => {
  test('redirects an anonymous visitor to sign-in', async ({ page }) => {
    await page.goto('/account')
    await expect(page).toHaveURL(/sign-in/)
  })

  test('preserves the requested path and returns there after sign-in', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('returnto')
    await signUp(page, email)
    await context.clearCookies()

    await page.goto('/account')
    await expect(page).toHaveURL(/next=%2Faccount/)

    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    // The explicit destination wins over the default landing page.
    await page.waitForURL('**/account')
  })

  test('rejects a forged session cookie', async ({ page, context }) => {
    // The proxy only sees that a cookie exists; the database check is what
    // actually rejects it.
    await context.addCookies([
      {
        name: 'nexus_session',
        value: 'forged-token-value',
        domain: 'localhost',
        path: '/',
      },
    ])

    await page.goto('/account')
    await expect(page).toHaveURL(/sign-in/)
  })

  test('sends an authenticated visitor away from the sign-in page', async ({ page }) => {
    await signUp(page, uniqueEmail('guest'))
    await page.goto('/sign-in')
    // requireGuest sends an authenticated visitor away from the auth screens.
    await expect(page).toHaveURL(/account/)
  })
})

test.describe('session management', () => {
  test('lists the current device and records the sign-in', async ({ page }) => {
    await signUp(page, uniqueEmail('sessions'))

    await expect(page.getByText('This device')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Recent sign-in activity' })).toBeVisible()
  })

  test('revokes another session, ending its access', async ({ browser }) => {
    const email = uniqueEmail('revoke')

    const first = await browser.newContext()
    const firstPage = await first.newPage()
    await signUp(firstPage, email)

    // A second, independent browser context — a different device.
    const second = await browser.newContext()
    const secondPage = await second.newPage()
    await signIn(secondPage, email)
    await secondPage.waitForURL('**/organizations/new')
    await secondPage.goto('/account')

    // The first device sees two sessions and terminates the other one.
    await firstPage.reload()
    await expect(
      firstPage.getByRole('button', { name: 'Sign out all other sessions' }),
    ).toBeVisible()
    await firstPage.getByRole('button', { name: 'Sign out all other sessions' }).click()

    // The control disappears once nothing else is signed in — the section is
    // only rendered while other sessions exist.
    await expect(
      firstPage.getByRole('button', { name: 'Sign out all other sessions' }),
    ).toBeHidden()

    // The revoked device loses access on its next request.
    await secondPage.goto('/account')
    await expect(secondPage).toHaveURL(/sign-in/)

    await first.close()
    await second.close()
  })
})

test.describe('password reset', () => {
  test('gives the same answer for registered and unknown addresses', async ({ page }) => {
    const email = uniqueEmail('reset')
    await signUp(page, email)
    await page.context().clearCookies()

    await page.goto('/forgot-password')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Send reset link' }).click()
    const registered = await page.getByRole('status').textContent()

    await page.goto('/forgot-password')
    await page.getByLabel('Email').fill(uniqueEmail('unknown'))
    await page.getByRole('button', { name: 'Send reset link' }).click()
    const unknown = await page.getByRole('status').textContent()

    expect(registered).toBe(unknown)
  })

  test('refuses an invalid reset token', async ({ page }) => {
    await page.goto('/reset-password?token=not-a-real-token')
    await page.getByLabel('New password').fill('a completely new passphrase')
    await page.getByRole('button', { name: 'Set new password' }).click()

    await expect(page.getByText(/not valid/i)).toBeVisible()
  })

  test('shows a clear message when the link has no token', async ({ page }) => {
    await page.goto('/reset-password')
    await expect(page.getByText(/incomplete/i)).toBeVisible()
  })
})

test.describe('email verification', () => {
  test('refuses an invalid confirmation token', async ({ page }) => {
    await page.goto('/verify-email?token=not-a-real-token')
    await page.getByRole('button', { name: 'Confirm email address' }).click()
    await expect(page.getByText(/not valid/i)).toBeVisible()
  })

  test('does not consume the token merely by loading the page', async ({ page }) => {
    // Link scanners fetch URLs in email; confirmation must require a click.
    await page.goto('/verify-email?token=some-token')
    await expect(page.getByRole('button', { name: 'Confirm email address' })).toBeVisible()
  })
})
