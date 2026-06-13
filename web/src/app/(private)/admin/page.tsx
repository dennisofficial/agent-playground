'use client';

import { useSearchParams } from 'next/navigation';
import { useGetProjectsQuery } from '@/redux/query/api/projectApi';
import { useGetTokensQuery } from '@/redux/query/api/tokenApi';
import { ProjectForm } from './_components/project-form';
import { ProjectRow } from './_components/project-row';
import { TokenForm } from './_components/token-form';
import { TokenRow } from './_components/token-row';

function errorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/**
 * The admin surface for the project registry + GitHub token store.
 *
 * Reads the Slack workspace team_id from the ?team= URL search param so the
 * same deployed portal can serve any tenant without a redeploy.  If the param
 * is absent a prompt is shown instead of fetching.
 *
 * Data is fetched via RTK Query; cache invalidation on mutations drives refetch
 * automatically. Auth protection is handled by the enclosing
 * (private)/layout.tsx — this component can assume the user is authenticated.
 */
export default function AdminPage() {
  const searchParams = useSearchParams();
  const teamId = searchParams.get('team') ?? '';

  const {
    data: projects,
    isLoading: projectsLoading,
    error: projectsError,
  } = useGetProjectsQuery(teamId, { skip: !teamId });

  const {
    data: tokens,
    isLoading: tokensLoading,
    error: tokensError,
  } = useGetTokensQuery(teamId, { skip: !teamId });

  if (!teamId) {
    return (
      <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        <h2 className="font-semibold">No workspace selected</h2>
        <p className="mt-2">
          Add a <code className="font-mono">?team=</code> query param to the URL with your
          Slack workspace team_id (e.g.{' '}
          <code className="font-mono">?team=T0123456789</code>).
        </p>
      </section>
    );
  }

  const anyError = projectsError ?? tokensError;
  if (anyError) {
    return (
      <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <h2 className="font-semibold">Backend admin API unreachable</h2>
        <p className="mt-2 font-mono text-xs">{errorMessage(anyError)}</p>
        <ul className="mt-3 list-disc pl-5">
          <li>
            Start the api app:{' '}
            <code className="font-mono">pnpm dev:env -- nest start api</code>{' '}
            (in <code className="font-mono">backend/</code>)
          </li>
          <li>
            Make sure the <code className="font-mono">?team=</code> param in the URL matches a
            real Slack workspace team_id.
          </li>
        </ul>
      </section>
    );
  }

  if (projectsLoading || tokensLoading || !projects || !tokens) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  const tokenNames = tokens.map((t) => t.name);

  return (
    <>
      <section>
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">GitHub tokens</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Values are write-only — they can be rotated or deleted, never read back. Projects
          without an override use the default.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {tokens.length === 0 ? (
            <p className="text-sm text-zinc-500">No tokens stored yet.</p>
          ) : (
            tokens.map((t) => (
              <TokenRow key={t.name} teamId={teamId} token={t} />
            ))
          )}
        </div>
        <TokenForm teamId={teamId} />
      </section>

      <section className="mt-12">
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">Projects</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          A project binds a room&apos;s project id to the GitHub repo its shared branches
          publish to. Unregistered projects stay local-only.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {projects.length === 0 ? (
            <p className="text-sm text-zinc-500">No projects registered yet.</p>
          ) : (
            projects.map((p) => (
              <ProjectRow
                key={p.projectId}
                teamId={teamId}
                project={p}
                tokenNames={tokenNames}
              />
            ))
          )}
        </div>
        <ProjectForm teamId={teamId} tokenNames={tokenNames} />
      </section>
    </>
  );
}
