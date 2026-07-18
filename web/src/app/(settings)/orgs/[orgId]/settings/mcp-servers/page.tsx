'use client';

import { McpSection } from '@/features/settings/components/mcp-section';
import { useOrg } from '@/lib/api/me';
import { use } from 'react';

export default function McpServersSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <McpSection orgId={org.id} role={org.role} />;
}
