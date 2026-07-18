'use client';

import { CredentialsSection } from '@/features/settings/components/credentials-section';
import { useOrg } from '@/lib/api/me';
import { use } from 'react';

export default function CredentialsSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <CredentialsSection orgId={org.id} role={org.role} />;
}
