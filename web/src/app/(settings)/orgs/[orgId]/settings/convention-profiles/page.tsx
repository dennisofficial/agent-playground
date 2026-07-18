'use client';

import { ConventionProfilesSection } from '@/features/settings/components/convention-profiles-section';
import { useOrg } from '@/lib/api/me';
import { use } from 'react';

export default function ConventionProfilesSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <ConventionProfilesSection orgId={org.id} role={org.role} />;
}
