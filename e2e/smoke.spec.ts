import { expect, test } from '@playwright/test'

/**
 * The signed-out surface.
 *
 * Everything a visitor can reach without an account: the landing page, the
 * theme switch, the security headers, and the rule that an unknown path is
 * treated as somebody else's tenant route rather than a 404.
 */
test.describe('the signed-out surface', () => {
  test('offers a way in', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create an organization' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Colour theme' })).toBeVisible()

    await page.getByRole('link', { name: 'Create an organization' }).click()
    await expect(page).toHaveURL(/sign-up/)
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
