'use client';

import { MembersSection } from '@/features/settings/components/members-section';
import { useOrg } from '@/lib/api/me';
import { use } from 'react';

export default function MembersSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <MembersSection orgId={org.id} orgName={org.name} />;
}
