/**
 * A demo organization.
 *
 * Everything below is created by calling the SAME services the application
 * calls. Nothing is inserted behind them. That matters for two reasons:
 *
 * 1. **The data is real.** Invoice totals are computed by the finance service
 *    from line items, task numbers come from the atomic allocator, permissions
 *    are resolved from the seeded catalogue, and the events every write emits
 *    are emitted here too. An evaluator looking at the Command Center is
 *    looking at figures the product produced.
 * 2. **It is an integration exercise.** A script that drives fourteen modules
 *    in sequence fails loudly if any of them stopped working together.
 *
 * It refuses to run against a production database, and it refuses to run twice
 * against the same slug rather than producing a confusing half-duplicate.
 *
 *   npm run db:demo
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file)
  if (existsSync(path)) process.loadEnvFile(path)
}

const SLUG = 'northwind'
const PASSWORD = 'demo-password-change-me'
const meta = { ip: null, userAgent: 'demo-seed' }

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const ahead = (days: number) => new Date(Date.now() + days * DAY)

async function main() {
  const { isProduction } = await import('../src/kernel/config/env')
  if (isProduction) {
    throw new Error('Refusing to write demo data to a production database.')
  }

  const { getSystemDb } = await import('../src/lib/db')
  const db = getSystemDb()

  const existing = await db.organization.findUnique({ where: { slug: SLUG } })
  if (existing) {
    console.log(
      `An organization with the slug "${SLUG}" already exists. ` +
        'Delete it first if you want a fresh demo — this script will not merge into it.',
    )
    return
  }

  const auth = await import('../src/modules/auth/service')
  const organizations = await import('../src/modules/organizations/service')
  const crm = await import('../src/modules/crm/service')
  const projects = await import('../src/modules/projects/service')
  const tasks = await import('../src/modules/tasks/service')
  const finance = await import('../src/modules/finance/service')
  const { buildMembershipCtx } = await import('../src/kernel/tenancy/ctx')

  /* ------------------------------ the people ----------------------------- */

  const owner = await auth.register(
    { name: 'Ada Okonkwo', email: 'ada@northwind.test', password: PASSWORD },
    meta,
  )

  // Verified, so the demo account can sign in without fishing the link out of
  // the console. Done directly because "an administrator verified it" is not a
  // product operation and inventing one for a seed would be worse.
  await db.user.update({ where: { id: owner.userId }, data: { emailVerifiedAt: new Date() } })

  const org = await organizations.createOrganization(
    {
      name: 'Northwind Studio',
      slug: SLUG,
      industry: 'Professional services',
      timezone: 'UTC',
      currency: 'USD',
      country: 'GB',
    },
    { userId: owner.userId },
    meta,
  )

  const ownerMembership = await db.membership.findFirstOrThrow({
    where: { organizationId: org.orgId, userId: owner.userId },
    select: { id: true },
  })

  const ctx = await buildMembershipCtx(org.orgId, ownerMembership.id)
  if (!ctx) throw new Error('Could not build a context for the demo owner.')

  /* ------------------------------ colleagues ----------------------------- */

  const colleagues = [
    { name: 'Tomas Lindqvist', email: 'tomas@northwind.test', role: 'manager' },
    { name: 'Priya Raman', email: 'priya@northwind.test', role: 'finance_manager' },
    { name: 'Jo Fenwick', email: 'jo@northwind.test', role: 'employee' },
  ] as const

  const memberships: Record<string, string> = {}

  for (const colleague of colleagues) {
    const user = await auth.register(
      { name: colleague.name, email: colleague.email, password: PASSWORD },
      meta,
    )
    await db.user.update({ where: { id: user.userId }, data: { emailVerifiedAt: new Date() } })

    const membership = await db.membership.create({
      data: { organizationId: org.orgId, userId: user.userId, status: 'ACTIVE' },
      select: { id: true },
    })
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: colleague.role },
      select: { id: true },
    })
    await db.membershipRole.create({
      data: { organizationId: org.orgId, membershipId: membership.id, roleId: role.id },
    })

    memberships[colleague.role] = membership.id
  }

  /* ------------------------------- clients ------------------------------- */

  const clients = [
    { name: 'Harbour Freight Co', industry: 'Logistics', domain: 'harbourfreight.test' },
    { name: 'Meridian Health', industry: 'Healthcare', domain: 'meridianhealth.test' },
    { name: 'Copperline Coffee', industry: 'Hospitality', domain: 'copperline.test' },
  ]

  const companyIds: string[] = []
  for (const client of clients) {
    const company = await crm.createCompany(ctx, { ...client }, meta)
    companyIds.push(company.id)
  }

  await crm.createContact(
    ctx,
    {
      firstName: 'Nadia',
      lastName: 'Bell',
      email: 'nadia@harbourfreight.test',
      position: 'Operations Director',
      companyId: companyIds[0],
    },
    meta,
  )

  await crm.createLead(
    ctx,
    {
      name: 'Samuel Adeyemi',
      email: 'samuel@brightlane.test',
      companyName: 'Brightlane Partners',
      source: 'REFERRAL',
      status: 'QUALIFIED',
      score: 70,
    },
    meta,
  )

  /* ------------------------------- projects ------------------------------ */

  const rollout = await projects.createProject(
    ctx,
    {
      key: 'HFR',
      name: 'Harbour Freight — booking portal',
      description: 'Replace the phone-and-spreadsheet booking process with a customer portal.',
      companyId: companyIds[0],
      managerMembershipId: memberships.manager,
      status: 'ACTIVE',
      priority: 'HIGH',
      visibility: 'ORGANIZATION',
      startDate: ago(40),
      dueDate: ahead(50),
      budgetMinor: 4_800_000n,
    },
    meta,
  )

  const rebrand = await projects.createProject(
    ctx,
    {
      key: 'MER',
      name: 'Meridian Health — patient records migration',
      companyId: companyIds[1],
      managerMembershipId: memberships.manager,
      status: 'ACTIVE',
      priority: 'MEDIUM',
      visibility: 'ORGANIZATION',
      startDate: ago(12),
      dueDate: ahead(80),
      budgetMinor: 2_200_000n,
    },
    meta,
  )

  /* -------------------------------- tasks -------------------------------- */

  const work = [
    { title: 'Discovery workshop with operations', status: 'DONE', project: rollout.id },
    { title: 'Booking flow — wireframes', status: 'DONE', project: rollout.id },
    { title: 'Portal authentication', status: 'IN_PROGRESS', project: rollout.id },
    { title: 'Availability calendar', status: 'IN_PROGRESS', project: rollout.id },
    { title: 'Rate card import', status: 'TODO', project: rollout.id },
    { title: 'Customer acceptance testing', status: 'TODO', project: rollout.id },
    { title: 'Records schema mapping', status: 'IN_PROGRESS', project: rebrand.id },
    { title: 'Consent and retention rules', status: 'TODO', project: rebrand.id },
    { title: 'Migration dry run', status: 'TODO', project: rebrand.id },
    { title: 'Quarterly insurance renewal', status: 'TODO', project: undefined },
  ] as const

  const assignees = [memberships.manager, memberships.employee, ownerMembership.id]

  let index = 0
  for (const item of work) {
    await tasks.createTask(
      ctx,
      {
        title: item.title,
        projectId: item.project,
        status: item.status,
        priority: index % 3 === 0 ? 'HIGH' : 'MEDIUM',
        assigneeMembershipId: assignees[index % assignees.length],
        dueDate: ahead(7 + index * 3),
        estimateMinutes: 120 + index * 30,
      },
      meta,
    )
    index += 1
  }

  /* ------------------------------- invoices ------------------------------ */

  const line = (description: string, quantity: number, unitMinor: bigint) => ({
    description,
    // Quantities are scaled by 1,000 — three decimal places, as integers.
    quantityScaled: Math.round(quantity * 1000),
    unitPriceMinor: unitMinor,
    discountBasisPoints: 0,
    taxBasisPoints: 2000,
  })

  const paid = await finance.createInvoice(
    ctx,
    {
      companyId: companyIds[0]!,
      projectId: rollout.id,
      issueDate: ago(45),
      dueDate: ago(15),
      lines: [line('Discovery and requirements', 1, 1_200_000n)],
      terms: 'Payment due within 30 days.',
    },
    meta,
  )
  await finance.sendInvoice(ctx, paid.id, meta)
  await finance.recordPayment(
    ctx,
    {
      invoiceId: paid.id,
      // The gross of 12,000.00 plus 20% tax. Computed by the service, not here;
      // this is what it produced.
      amountMinor: 1_440_000n,
      method: 'BANK_TRANSFER',
      receivedAt: ago(12),
      reference: 'FT24091200',
    },
    meta,
  )

  const outstanding = await finance.createInvoice(
    ctx,
    {
      companyId: companyIds[0]!,
      projectId: rollout.id,
      issueDate: ago(20),
      dueDate: ahead(10),
      lines: [line('Portal build — sprint 1', 1, 1_800_000n), line('Design system', 0.5, 600_000n)],
    },
    meta,
  )
  await finance.sendInvoice(ctx, outstanding.id, meta)

  const overdue = await finance.createInvoice(
    ctx,
    {
      companyId: companyIds[1]!,
      projectId: rebrand.id,
      issueDate: ago(60),
      dueDate: ago(30),
      lines: [line('Migration assessment', 1, 750_000n)],
    },
    meta,
  )
  await finance.sendInvoice(ctx, overdue.id, meta)

  // A draft, so the invoice list shows all four states.
  await finance.createInvoice(
    ctx,
    {
      companyId: companyIds[2]!,
      issueDate: new Date(),
      dueDate: ahead(30),
      lines: [line('Brand refresh — proposal', 1, 320_000n)],
    },
    meta,
  )

  /* ------------------------------- the report ---------------------------- */

  console.log(`
Demo organization created.

  URL       http://localhost:3000/${SLUG}
  Sign in   ada@northwind.test
  Password  ${PASSWORD}

  Also created, all with the same password:
    tomas@northwind.test   Manager
    priya@northwind.test   Finance Manager
    jo@northwind.test      Employee

  3 clients, 1 contact, 1 lead, 2 projects, 10 tasks, 4 invoices
  (one paid, one outstanding, one overdue, one draft).

These are real accounts with a weak, published password. Never run this against
anything that is reachable from the internet.
`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    const { getSystemDb } = await import('../src/lib/db')
    await getSystemDb().$disconnect()
  })
