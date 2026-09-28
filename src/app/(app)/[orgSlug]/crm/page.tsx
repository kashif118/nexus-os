import { redirect } from 'next/navigation'

export default async function CrmIndexPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  redirect(`/${orgSlug}/crm/pipeline`)
}
