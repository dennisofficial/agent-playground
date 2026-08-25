import { SITE_MAP } from '@/lib/site-map';
import { redirect } from 'next/navigation';

/**
 * `/orgs/:orgId/settings` — the bare path has no content of its own; redirect to the General section.
 * Exception: the GitHub App install callback returns the owner here with `?githubApp=…` (and no section),
 * so forward that — query preserved — to the Credentials section, where the connect card reads the result.
 */
export default async function OrgSettingsIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  if (sp.githubApp !== undefined) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) {
      if (typeof value === 'string') qs.set(key, value);
      else if (Array.isArray(value) && value[0] !== undefined) qs.set(key, value[0]);
    }
    redirect(`${SITE_MAP.orgs.org(orgId).settings.section('credentials')()}?${qs.toString()}`);
  }
  redirect(SITE_MAP.orgs.org(orgId).settings.section('general')());
}
