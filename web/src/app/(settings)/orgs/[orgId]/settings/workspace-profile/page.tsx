'use client';

import { WorkspaceProfileSection } from '@/features/settings/components/workspace-profile-section';
import { useOrg } from '@/lib/api/me';
import { use } from 'react';

export default function WorkspaceProfileSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <WorkspaceProfileSection orgId={org.id} role={org.role} />;
}
