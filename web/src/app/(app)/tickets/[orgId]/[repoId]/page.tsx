'use client';

import { use } from 'react';
import { TicketsWorkspace } from '@/features/tickets/tickets-workspace';

/**
 * One repo's tickets board + backlog. `orgId`/`repoId` come from the route (the repo sidebar links here);
 * the repo's board is rendered for that scope. Board/backlog/drawer state lives in `TicketsWorkspace`.
 */
export default function RepoTicketsPage({
  params,
}: {
  params: Promise<{ orgId: string; repoId: string }>;
}) {
  const { orgId, repoId } = use(params);
  return <TicketsWorkspace orgId={orgId} repoId={repoId} />;
}
