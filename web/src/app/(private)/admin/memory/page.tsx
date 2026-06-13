'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import { listTenants, listAllFacts } from '@/lib/admin-api';
import type { TenantView, FactView } from '@/lib/admin-api';
import { MemoryViewer } from './memory-viewer';

/**
 * Memory Viewer — admin read-only view over agent semantic memory across all workspaces.
 * Auth gate is handled by (private)/layout.tsx (httpOnly cookie check + redirect).
 * Data is fetched client-side via auth.httpClient (cookie sent automatically, 401 → refresh).
 */
export default function MemoryPage() {
  const searchParams = useSearchParams();
  const teamParam = searchParams.get('team') ?? undefined;

  const [tenants, setTenants] = useState<TenantView[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>();
  const [facts, setFacts] = useState<FactView[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const ts = await listTenants();
        if (cancelled) return;
        setTenants(ts);

        const teamId = ts.find((t) => t.id === teamParam)?.id ?? ts[0]?.id;
        setSelectedTeamId(teamId);

        if (teamId) {
          const result = await listAllFacts(teamId);
          if (cancelled) return;
          setFacts(result.facts);
          setTruncated(result.truncated);
          setTotal(result.total);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teamParam]);

  if (loading) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading memory…</p>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <h2 className="font-semibold">Backend admin API unreachable</h2>
        <p className="mt-2 font-mono text-xs">{error}</p>
        <ul className="mt-3 list-disc pl-5">
          <li>
            Start the api app:{' '}
            <code className="font-mono">pnpm dev:env -- nest start api</code>
          </li>
        </ul>
      </section>
    );
  }

  if (tenants.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No workspaces registered yet.
      </p>
    );
  }

  return (
    <MemoryViewer
      tenants={tenants}
      selectedTeamId={selectedTeamId!}
      facts={facts}
      truncated={truncated}
      total={total}
    />
  );
}
