'use client';

import { ProjectForm as BaseProjectForm } from '@/app/(private)/admin/_components/project-form';

/**
 * Thin adapter over the shared ProjectForm that omits the `onSuccess` callback.
 * Used by the server-rendered /admin page.
 */
export function ProjectForm({
  teamId,
  tokenNames,
}: {
  teamId: string;
  tokenNames: string[];
}) {
  return <BaseProjectForm teamId={teamId} tokenNames={tokenNames} onSuccess={() => {}} />;
}
