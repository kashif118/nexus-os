import { expect, test } from '@playwright/test'

/**
 * Foundation smoke test. Grows into the critical-journey suite listed in
 * docs/OPERATIONS.md §O.2 as the modules that make those journeys possible land.
 */
test.describe('foundation', () => {
  test('renders the application shell', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'What this phase established' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Colour theme' })).toBeVisible()
  })

  test('switches to the dark theme', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('sends security headers', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.headers()['x-content-type-options']).toBe('nosniff')
    expect(response?.headers()['x-frame-options']).toBe('DENY')
  })

  test('sends an anonymous visitor on an unknown route to sign-in', async ({ page }) => {
    // Since Phase 03 every path outside the public list is treated as
    // protected: organization slugs cannot be enumerated in the edge proxy, so
    // an unknown path is assumed to be a tenant route. The 404 behaviour for a
    // signed-in non-member is covered in tenancy.spec.ts.
    await page.goto('/this-route-does-not-exist')
    await expect(page).toHaveURL(/sign-in/)
  })
})
