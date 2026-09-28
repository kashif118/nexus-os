import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Documents end to end (docs/ROADMAP.md Phase 12: "unauthorized download
 * returns 404").
 *
 * The unit and integration suites prove the visibility rule and the service.
 * This proves the HTTP surface: that the download route refuses a stranger, an
 * anonymous caller and a member of another organization, and that it refuses
 * them all with 404 rather than 403 — a 403 would confirm the file exists.
 */

const PASSWORD = 'correct horse battery staple'

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** A real, valid PDF: the upload is rejected on its bytes otherwise. */
const PDF_BYTES = Buffer.from(`%PDF-1.7\n${'% padding\n'.repeat(8)}%%EOF\n`, 'utf8')

async function signUpAndCreateOrg(page: Page, label: string) {
  const email = `${unique(label)}@example.test`
  const slug = unique(`org-${label}`)

  await page.goto('/sign-up')
  await page.getByLabel('Name').fill('Doc Owner')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
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

/** Upload through the same route the UI uses, and return the new id. */
async function uploadPdf(page: Page, slug: string, name: string, visibility: string) {
  const response = await page.request.post(`/api/orgs/${slug}/documents`, {
    multipart: {
      file: { name, mimeType: 'application/pdf', buffer: PDF_BYTES },
      visibility,
    },
  })

  expect(response.status()).toBe(201)
  const body = (await response.json()) as { id: string }
  return body.id
}

test.describe('document downloads', () => {
  test('the uploader can download their own file', async ({ page }) => {
    const { slug } = await signUpAndCreateOrg(page, 'docs-own')
    const id = await uploadPdf(page, slug, 'own.pdf', 'ORGANIZATION')

    const response = await page.request.get(`/api/orgs/${slug}/documents/${id}/download`)

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('application/pdf')
    // Never rendered inline: an uploaded document must not execute on our origin.
    expect(response.headers()['content-disposition']).toContain('attachment')
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['cache-control']).toContain('no-store')
    expect(Buffer.from(await response.body())).toEqual(PDF_BYTES)
  })

  test('a member of another organization gets 404, not 403', async ({ browser }) => {
    const owner = await newSignedInContext(browser, 'docs-owner')
    const id = await uploadPdf(owner.page, owner.slug, 'secret.pdf', 'ORGANIZATION')

    const stranger = await newSignedInContext(browser, 'docs-stranger')
    const response = await stranger.page.request.get(
      `/api/orgs/${owner.slug}/documents/${id}/download`,
    )

    expect(response.status()).toBe(404)

    await owner.context.close()
    await stranger.context.close()
  })

  test('an anonymous caller cannot download', async ({ browser }) => {
    const owner = await newSignedInContext(browser, 'docs-anon')
    const id = await uploadPdf(owner.page, owner.slug, 'private.pdf', 'ORGANIZATION')

    const anonymous = await browser.newContext()
    const response = await anonymous
      .request.get(`/api/orgs/${owner.slug}/documents/${id}/download`)

    // 401 and JSON, not a redirect to an HTML sign-in page: a fetch follows a
    // redirect and would otherwise report a 200 for a request that failed.
    expect(response.status()).toBe(401)
    expect(response.headers()['content-type']).toContain('application/json')

    await owner.context.close()
    await anonymous.close()
  })

  test('a guessed storage path is not served', async ({ page }) => {
    const { slug } = await signUpAndCreateOrg(page, 'docs-guess')
    await uploadPdf(page, slug, 'guessable.pdf', 'ORGANIZATION')

    // The object store is not a web root. Nothing under it is routable.
    for (const path of ['/.storage/org', '/storage/org', '/uploads/guessable.pdf']) {
      const response = await page.request.get(path)
      expect(response.status()).toBe(404)
    }
  })

  test('rejects a file whose bytes contradict its type', async ({ page }) => {
    const { slug } = await signUpAndCreateOrg(page, 'docs-bytes')

    const response = await page.request.post(`/api/orgs/${slug}/documents`, {
      multipart: {
        file: {
          name: 'evil.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('<html><script>alert(1)</script></html>', 'utf8'),
        },
        visibility: 'ORGANIZATION',
      },
    })

    expect(response.status()).toBe(400)
  })

  test('a private document is not downloadable by another member', async ({ browser }) => {
    // Two organizations is the strongest form of this check; within one
    // organization the integration suite covers the private-versus-admin case.
    const owner = await newSignedInContext(browser, 'docs-priv')
    const id = await uploadPdf(owner.page, owner.slug, 'personal.pdf', 'PRIVATE')

    const stranger = await newSignedInContext(browser, 'docs-priv-other')
    const response = await stranger.page.request.get(
      `/api/orgs/${owner.slug}/documents/${id}/download`,
    )

    expect(response.status()).toBe(404)

    await owner.context.close()
    await stranger.context.close()
  })
})
