'use client';

import { useEffect, useState } from 'react';
import { listProjects, listTokens } from '@/lib/admin-api';
import type { GithubTokenMeta, ProjectRecord } from '@/lib/admin-api';
import { ProjectForm } from '../../admin/project-form';
import { ProjectRow } from '../../admin/project-row';
import { TokenForm } from '../../admin/token-form';
import { TokenRow } from '../../admin/token-row';

type Data = { projects: ProjectRecord[]; tokens: GithubTokenMeta[] };

/**
 * The admin surface for the project registry + GitHub token store.
 *
 * Fetches data client-side on mount (and after each successful mutation via
 * onSuccess callbacks). Auth protection is handled by the enclosing
 * (private)/layout.tsx — this component can assume the user is authenticated.
 */
export default function AdminPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [projects, tokens] = await Promise.all([listProjects(), listTokens()]);
      setData({ projects, tokens });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <h2 className="font-semibold">Backend admin API unreachable</h2>
        <p className="mt-2 font-mono text-xs">{error}</p>
        <ul className="mt-3 list-disc pl-5">
          <li>
            Start the api app:{' '}
            <code className="font-mono">pnpm dev:env -- nest start api</code>{' '}
            (in <code className="font-mono">backend/</code>)
          </li>
          <li>
            Make sure <code className="font-mono">NEXT_PUBLIC_TEAM_ID</code> is set in{' '}
            <code className="font-mono">web/.env.personal</code> (your Slack workspace
            team_id).
          </li>
        </ul>
      </section>
    );
  }

  if (!data) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  const tokenNames = data.tokens.map((t) => t.name);

  return (
    <>
      <section>
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">GitHub tokens</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Values are write-only — they can be rotated or deleted, never read back. Projects
          without an override use the default.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {data.tokens.length === 0 ? (
            <p className="text-sm text-zinc-500">No tokens stored yet.</p>
          ) : (
            data.tokens.map((t) => (
              <TokenRow key={t.name} token={t} onSuccess={load} />
            ))
          )}
        </div>
        <TokenForm onSuccess={load} />
      </section>

      <section className="mt-12">
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">Projects</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          A project binds a room&apos;s project id to the GitHub repo its shared branches
          publish to. Unregistered projects stay local-only.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {data.projects.length === 0 ? (
            <p className="text-sm text-zinc-500">No projects registered yet.</p>
          ) : (
            data.projects.map((p) => (
              <ProjectRow
                key={p.projectId}
                project={p}
                tokenNames={tokenNames}
                onSuccess={load}
              />
            ))
          )}
        </div>
        <ProjectForm tokenNames={tokenNames} onSuccess={load} />
      </section>
    </>
  );
}
