'use client';

import { ProjectRow as BaseProjectRow } from '@/app/(private)/admin/_components/project-row';
import type { ProjectRecord } from '@/lib/admin-api';

/**
 * Thin adapter over the shared ProjectRow that omits the `onSuccess` callback.
 * Used by the server-rendered /admin page.
 */
export function ProjectRow({
  teamId,
  project,
  tokenNames,
}: {
  teamId: string;
  project: ProjectRecord;
  tokenNames: string[];
}) {
  return (
    <BaseProjectRow
      teamId={teamId}
      project={project}
      tokenNames={tokenNames}
      onSuccess={() => {}}
    />
  );
}
