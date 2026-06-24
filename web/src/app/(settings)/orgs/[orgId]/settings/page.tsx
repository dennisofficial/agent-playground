'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { OrgSettings } from '@/features/settings/components/org-settings';
import type { SettingsSection } from '@/lib/routes';

const SECTIONS = new Set<SettingsSection>(['general', 'credentials', 'members']);

/** `/orgs/:orgId/settings` — the Org & Settings screen. `?section=` deep-links a tab. */
export default function OrgSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const sectionParam = useSearchParams().get('section');
  const initialSection: SettingsSection =
    sectionParam && SECTIONS.has(sectionParam as SettingsSection)
      ? (sectionParam as SettingsSection)
      : 'general';

  return <OrgSettings orgId={orgId} initialSection={initialSection} />;
}
