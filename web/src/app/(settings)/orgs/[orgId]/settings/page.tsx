'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { OrgSettings } from '@/features/settings/components/org-settings';
import type { SettingsSection } from '@/lib/routes';

const SECTIONS = new Set<SettingsSection>([
  'general',
  'credentials',
  'worktree-secrets',
  'members',
  'repos',
]);

/** `/orgs/:orgId/settings` — the Org & Settings screen. `?section=` deep-links a tab. */
export default function OrgSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const sectionParam = useSearchParams().get('section');
  const initialSection: SettingsSection =
    sectionParam && SECTIONS.has(sectionParam as SettingsSection)
      ? (sectionParam as SettingsSection)
      : 'general';

  // Keyed by orgId so switching orgs from the settings breadcrumb remounts onto the new org and re-applies
  // `initialSection` (the preserved `?section`) — internal `section` state resets to the navigated tab.
  return <OrgSettings key={orgId} orgId={orgId} initialSection={initialSection} />;
}
