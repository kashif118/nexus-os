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

  test('returns a 404 page for an unknown route', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })
})
