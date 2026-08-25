'use client';

import { AutomationSection } from '@/features/settings/components/automation-section';
import { useOrg } from '@/lib/api/me';
import { use } from 'react';

export default function AutomationSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <AutomationSection org={org} />;
}
