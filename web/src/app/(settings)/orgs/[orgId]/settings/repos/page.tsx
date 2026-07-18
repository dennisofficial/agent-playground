'use client';

import { ReposSection } from '@/features/settings/components/repos-section';
import { useOrg } from '@/lib/api/me';
import { ROUTES } from '@/lib/routes';
import { useRouter } from 'next/navigation';
import { use } from 'react';

export default function ReposSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  const router = useRouter();
  if (!org) return null;
  return (
    <ReposSection
      orgId={org.id}
      orgName={org.name}
      role={org.role}
      onNavigate={(section) => router.push(ROUTES.orgSettings(orgId, section))}
    />
  );
}
