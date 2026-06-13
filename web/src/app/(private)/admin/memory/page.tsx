import { connection } from 'next/server';
import { listAllFacts, listTenants } from '@/lib/admin-api';
import { MemoryViewer } from './memory-viewer';

/**
 * Memory Viewer — admin read-only view over agent semantic memory across all workspaces.
 * Gated by (private)/layout.tsx (httpOnly cookie check + redirect).
 * All data flows through the Next server; the admin bearer never reaches the browser.
 */
export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  await connection(); // never prerender — reads cookies + changes per workspace

  const sp = await searchParams;

  let tenants, factsResult;
  try {
    tenants = await listTenants();
  } catch (err) {
    return <BackendError err={err} />;
  }

  // Pick selected workspace: query param → first tenant alphabetically → null
  const selectedTeamId = tenants.find((t) => t.id === sp.team)?.id ?? tenants[0]?.id;

  if (tenants.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No workspaces registered yet.
      </p>
    );
  }

  try {
    factsResult = await listAllFacts(selectedTeamId!);
  } catch (err) {
    return <BackendError err={err} />;
  }

  return (
    <MemoryViewer
      tenants={tenants}
      selectedTeamId={selectedTeamId!}
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
      <p className="mt-2 font-mono text-xs">
        {err instanceof Error ? err.message : String(err)}
      </p>
      <ul className="mt-3 list-disc pl-5">
        <li>
          Start the api app:{' '}
          <code className="font-mono">pnpm dev:env -- nest start api</code> (in{' '}
          <code className="font-mono">backend/</code>)
        </li>
        <li>
          Make sure <code className="font-mono">ADMIN_API_TOKEN</code> is set in BOTH{' '}
          <code className="font-mono">backend/.env.personal</code> and{' '}
          <code className="font-mono">web/.env.personal</code> (same value)
        </li>
      </ul>
    </section>
  );
}
