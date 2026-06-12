import { connection } from 'next/server';
import { listAllFacts, listTenants } from '@/lib/admin-api';
import { requireAdmin } from '@/lib/admin-auth';
import { logoutAction } from '@/app/admin/actions';
import { MemoryViewer } from './memory-viewer';

/**
 * Memory Viewer — admin read-only view over agent semantic memory across all workspaces.
 * Gated by requireAdmin() (same httpOnly-cookie gate as the rest of the admin surface).
 * All data flows through the Next server; the admin bearer never reaches the browser.
 */
export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  await connection(); // never prerender — reads cookies + changes per workspace
  await requireAdmin();

  const sp = await searchParams;

  let tenants, factsResult;
  try {
    tenants = await listTenants();
  } catch (err) {
    return (
      <Shell>
        <BackendError err={err} />
      </Shell>
    );
  }

  // Pick selected workspace: query param → first tenant alphabetically → null
  const selectedTeamId = tenants.find((t) => t.id === sp.team)?.id ?? tenants[0]?.id;

  if (tenants.length === 0) {
    return (
      <Shell>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No workspaces registered yet.
        </p>
      </Shell>
    );
  }

  try {
    factsResult = await listAllFacts(selectedTeamId!);
  } catch (err) {
    return (
      <Shell>
        <BackendError err={err} />
      </Shell>
    );
  }

  return (
    <Shell>
      <MemoryViewer
        tenants={tenants}
        selectedTeamId={selectedTeamId!}
        facts={factsResult.facts}
        truncated={factsResult.truncated}
        total={factsResult.total}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-5xl">
        <header className="mb-10 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
              Agent Playground — Memory Viewer
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Read-only view of agent semantic memory across all workspaces
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/admin"
              className="text-sm text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              Admin
            </a>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Log out
              </button>
            </form>
          </div>
        </header>
        {children}
      </div>
    </main>
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
