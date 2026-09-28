import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Multi-tenancy end to end (docs/PLATFORM.md §H).
 *
 * The isolation matrix in `src/modules/organizations/__tests__` proves the data
 * layer cannot cross tenants. This proves the ROUTING layer: that a signed-in
 * user who is not a member of an organization cannot reach it by URL, and that
 * they are told 404 rather than 403.
 */

const PASSWORD = 'correct horse battery staple'

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function signUpAndCreateOrg(page: Page, label: string) {
  const email = `${unique(label)}@example.test`
  const slug = unique(`org-${label}`)

  await page.goto('/sign-up')
  await page.getByLabel('Name').fill('Test Owner')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  // A brand-new account belongs to no organization yet.
  await page.waitForURL('**/organizations/new')

  await page.getByLabel('Organization name').fill(`Org ${label}`)
  await page.getByLabel('Web address').fill(slug)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await page.waitForURL(`**/${slug}`)

  return { email, slug }
}

async function newSignedInContext(browser: Browser, label: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const created = await signUpAndCreateOrg(page, label)
  return { context, page, ...created }
}

test.describe('organization lifecycle', () => {
  test('creates an organization and lands in it', async ({ page }) => {
    const { slug } = await signUpAndCreateOrg(page, 'create')

    await expect(page).toHaveURL(new RegExp(`/${slug}$`))
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Org create')
  })

  test('rejects a duplicate web address', async ({ browser }) => {
    const first = await newSignedInContext(browser, 'dupe')

    const second = await browser.newContext()
    const page = await second.newPage()
    const email = `${unique('dupe-second')}@example.test`

    await page.goto('/sign-up')
    await page.getByLabel('Name').fill('Second Owner')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.waitForURL('**/organizations/new')

    await page.getByLabel('Organization name').fill('Collision')
    await page.getByLabel('Web address').fill(first.slug)
    await page.getByRole('button', { name: 'Create organization' }).click()

    await expect(page.getByText(/already taken/i)).toBeVisible()

    await first.context.close()
    await second.close()
  })

  test('rejects a reserved web address', async ({ page }) => {
    const email = `${unique('reserved')}@example.test`

    await page.goto('/sign-up')
    await page.getByLabel('Name').fill('Owner')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.waitForURL('**/organizations/new')

    await page.getByLabel('Organization name').fill('Admin Co')
    await page.getByLabel('Web address').fill('admin')
    await page.getByRole('button', { name: 'Create organization' }).click()

    await expect(page.getByText(/reserved/i)).toBeVisible()
  })
})

test.describe('tenant isolation at the routing layer', () => {
  test('a non-member gets 404, not 403, for another organization', async ({ browser }) => {
    const alpha = await newSignedInContext(browser, 'alpha')
    const beta = await newSignedInContext(browser, 'beta')

    // Beta is signed in and legitimate, but has no membership in Alpha.
    const response = await beta.page.goto(`/${alpha.slug}`)

    expect(response?.status()).toBe(404)
    // 403 would confirm the organization exists.
    await expect(beta.page.getByRole('heading', { name: 'Page not found' })).toBeVisible()

    await alpha.context.close()
    await beta.context.close()
  })

  test('a non-member cannot read another organization settings', async ({ browser }) => {
    const alpha = await newSignedInContext(browser, 'settings-alpha')
    const beta = await newSignedInContext(browser, 'settings-beta')

    const response = await beta.page.goto(`/${alpha.slug}/settings`)
    expect(response?.status()).toBe(404)

    await alpha.context.close()
    await beta.context.close()
  })

  test('a non-member cannot see another organization members', async ({ browser }) => {
    const alpha = await newSignedInContext(browser, 'members-alpha')
    const beta = await newSignedInContext(browser, 'members-beta')

    const response = await beta.page.goto(`/${alpha.slug}/settings/members`)
    expect(response?.status()).toBe(404)
    await expect(beta.page.getByText(alpha.email)).toHaveCount(0)

    await alpha.context.close()
    await beta.context.close()
  })

  test('an anonymous visitor is sent to sign-in, not shown the organization', async ({ page }) => {
    await page.goto('/some-organization-slug')
    await expect(page).toHaveURL(/sign-in/)
  })

  test('each member sees only their own organization in the switcher', async ({ browser }) => {
    const alpha = await newSignedInContext(browser, 'switcher-alpha')
    const beta = await newSignedInContext(browser, 'switcher-beta')

    await beta.page.goto(`/${beta.slug}`)
    const switcher = beta.page.getByRole('button', { name: /Org switcher-beta/ }).first()
    await switcher.click()

    await expect(beta.page.getByRole('menuitem', { name: /Org switcher-beta/ })).toBeVisible()
    await expect(beta.page.getByRole('menuitem', { name: /Org switcher-alpha/ })).toHaveCount(0)

    await alpha.context.close()
    await beta.context.close()
  })
})

test.describe('organization settings', () => {
  test('the owner can update settings and they persist', async ({ page }) => {
    const { slug } = await signUpAndCreateOrg(page, 'settings')

    await page.goto(`/${slug}/settings`)
    await page.getByLabel('Name').fill('Renamed Organization')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(page.getByText('Organization settings saved.')).toBeVisible()

    await page.reload()
    await expect(page.getByLabel('Name')).toHaveValue('Renamed Organization')
  })

  test('an invalid time zone is rejected server-side', async ({ page }) => {
    const { slug } = await signUpAndCreateOrg(page, 'tz')

    await page.goto(`/${slug}/settings`)
    await page.getByLabel('Time zone').fill('Not/AZone')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(page.locator('#timezone-error')).toContainText(/recognised time zone/i)
  })
})
