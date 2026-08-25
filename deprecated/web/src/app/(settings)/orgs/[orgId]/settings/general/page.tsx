'use client';

import { GeneralSection } from '@/features/settings/components/general-section';
import { useOrg } from '@/lib/api/me';
import { use } from 'react';

export default function GeneralSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <GeneralSection org={org} />;
}
