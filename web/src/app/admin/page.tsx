import { connection } from 'next/server';
import { listProjects, listTokens } from '@/lib/admin-api';
import { requireAdmin } from '@/lib/admin-auth';
import { logoutAction } from './actions';
import { ProjectForm } from './project-form';
import { ProjectRow } from './project-row';
import { TokenForm } from './token-form';
import { TokenRow } from './token-row';

/**
 * The admin surface for the project registry + GitHub token store. requireAdmin() reads cookies
 * (making the route request-bound — never prerendered) and bounces to /admin/login. All data
 * flows through the Next server; the browser never holds the admin bearer or token values.
 */
export default async function AdminPage() {
  await connection(); // belt-and-braces: never prerender any branch of this page
  await requireAdmin();

  let projects, tokens;
  try {
    [projects, tokens] = await Promise.all([listProjects(), listTokens()]);
  } catch (err) {
    return (
      <Shell>
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <h2 className="font-semibold">Backend admin API unreachable</h2>
          <p className="mt-2 font-mono text-xs">{err instanceof Error ? err.message : String(err)}</p>
          <ul className="mt-3 list-disc pl-5">
            <li>
              Start the api app: <code className="font-mono">pnpm dev:env -- nest start api</code>{' '}
              (in <code className="font-mono">backend/</code>)
            </li>
            <li>
              Make sure <code className="font-mono">ADMIN_API_TOKEN</code> is set in BOTH{' '}
              <code className="font-mono">backend/.env.personal</code> and{' '}
              <code className="font-mono">web/.env.personal</code> (same value)
            </li>
          </ul>
        </section>
      </Shell>
    );
  }

  const tokenNames = tokens.map((t) => t.name);
  return (
    <Shell>
      <section>
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">GitHub tokens</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Values are write-only — they can be rotated or deleted, never read back. Projects without
          an override use the default.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {tokens.length === 0 ? (
            <p className="text-sm text-zinc-500">No tokens stored yet.</p>
          ) : (
            tokens.map((t) => <TokenRow key={t.name} token={t} />)
          )}
        </div>
        <TokenForm />
      </section>

      <section className="mt-12">
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">Projects</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          A project binds a room&apos;s project id to the GitHub repo its shared branches publish
          to. Unregistered projects stay local-only.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {projects.length === 0 ? (
            <p className="text-sm text-zinc-500">No projects registered yet.</p>
          ) : (
            projects.map((p) => <ProjectRow key={p.projectId} project={p} tokenNames={tokenNames} />)
          )}
        </div>
        <ProjectForm tokenNames={tokenNames} />
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-3xl">
        <header className="mb-10 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
              Agent Playground — Admin
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              GitHub workspaces for the AI employees
            </p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Log out
            </button>
          </form>
        </header>
        {children}
      </div>
    </main>
  );
}
