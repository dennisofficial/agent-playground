'use client';

import { useSearchParams } from 'next/navigation';
import { useGetTenantsQuery, useGetAllFactsQuery } from '@/redux/query/api/memoryApi';
import { MemoryViewer } from './memory-viewer';

function getErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/**
 * Memory Viewer — admin read-only view over agent semantic memory across all workspaces.
 * Gated by (private)/layout.tsx (httpOnly cookie check + redirect).
 * Tenant list and facts are fetched client-side via RTK Query.
 */
export default function MemoryPage() {
  const searchParams = useSearchParams();
  const teamParam = searchParams.get('team') ?? undefined;

  const { data: tenants, isLoading: tenantsLoading, error: tenantsError } = useGetTenantsQuery();

  const selectedTeamId = tenants?.find((t) => t.id === teamParam)?.id ?? tenants?.[0]?.id;

  const {
    data: factsResult,
    isLoading: factsLoading,
    error: factsError,
  } = useGetAllFactsQuery({ teamId: selectedTeamId! }, { skip: !selectedTeamId });

  if (tenantsError || factsError) {
    return <BackendError err={tenantsError ?? factsError} />;
  }

  if (tenantsLoading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  if (!tenants || tenants.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No workspaces registered yet.
      </p>
    );
  }

  if (!selectedTeamId || factsLoading || !factsResult) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  return (
    <MemoryViewer
      tenants={tenants}
      selectedTeamId={selectedTeamId}
      facts={factsResult.facts}
      truncated={factsResult.truncated}
      total={factsResult.total}
    />
  );
}

function BackendError({ err }: { err: unknown }) {
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <h2 className="font-semibold">Backend admin API unreachable</h2>
      <p className="mt-2 font-mono text-xs">{getErrorMessage(err)}</p>
      <ul className="mt-3 list-disc pl-5">
        <li>
          Start the api app:{' '}
          <code className="font-mono">pnpm dev:env -- nest start api</code> (in{' '}
          <code className="font-mono">backend/</code>)
        </li>
        <li>
          Make sure the backend is reachable at{' '}
          <code className="font-mono">NEXT_PUBLIC_BACKEND_URL</code>
        </li>
      </ul>
    </section>
  );
}
