'use client';

import { useState } from 'react';
import { FileKey, Plus, Shield, Trash2 } from 'lucide-react';
import {
  useDeleteWorktreeSecret,
  useGrantWorktreeSecret,
  useRevokeWorktreeSecret,
  useSaveWorktreeSecret,
  useWorktreeSecrets,
  type WorktreeSecretGrant,
} from '@/lib/api/orgs';
import { useOrgRepos } from '@/lib/api/job-queries';

/**
 * Worktree secrets — named, encrypted secret files (`.env`, `.env.keys`, a service-account JSON, …) the
 * worktree hydrator renders into a thread's sandbox. The list is names-only (values are never returned). A
 * secret is INERT until an owner GRANTS it to a specific repo + destination path — the grant IS the render
 * instruction (the committed `.atlas/worktree.json` carries mounts/seed only, never secrets). Grants are
 * created here, or during repo onboarding by the secure secret prompt. Owner-only writes (the server
 * enforces it; members get a read-only view).
 */
export function WorktreeSecretsSection({ orgId, role }: { orgId: string; role: string }) {
  const { data, isLoading, isError } = useWorktreeSecrets(orgId);
  const isOwner = role === 'owner';

  if (isLoading) return <p className="text-[13px] text-faint">Loading worktree secrets…</p>;
  if (isError || !data) return <p className="text-[13px] text-red">Couldn’t load worktree secrets.</p>;

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">Worktree secrets</h1>
      <p className="mb-7 mt-1.5 text-[13px] leading-relaxed text-dim">
        Named secret files the build renders into a thread’s sandbox (e.g. <code className="font-mono text-[12px]">.env.keys</code>).
        Encrypted at rest — values are never shown. A secret only takes effect once you <strong>grant</strong> it
        to a repo and path — the grant is what renders it (the repo’s <code className="font-mono text-[12px]">.atlas/worktree.json</code> carries
        mounts and seed only, never secrets). Atlas also creates grants for you during repo onboarding.
      </p>

      {!isOwner ? (
        <div className="mb-5 rounded-md border border-border-2 bg-surface-2 px-3.5 py-2.5 text-[12px] text-dim">
          Only org owners can manage worktree secrets and grants.
        </div>
      ) : null}

      <SecretsCard orgId={orgId} names={data.names} canManage={isOwner} />
      <GrantsCard orgId={orgId} names={data.names} grants={data.grants} canManage={isOwner} />
    </>
  );
}

// ── Secrets ───────────────────────────────────────────────────────────────────────────────────────
function SecretsCard({ orgId, names, canManage }: { orgId: string; names: string[]; canManage: boolean }) {
  const save = useSaveWorktreeSecret(orgId);
  const del = useDeleteWorktreeSecret(orgId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    const n = name.trim();
    if (!n) return setError('Enter a secret name.');
    if (!value) return setError('Enter a value.');
    setError('');
    try {
      await save.mutateAsync({ name: n, value });
      setAdding(false);
      setName('');
      setValue('');
    } catch (e) {
      setError((e as Error)?.message || 'Could not save.');
    }
  }

  return (
    <div className="mb-3.5 rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-center gap-3">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-border-2 bg-surface-3 text-dim">
          <FileKey size={16} />
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-text">Secret values</div>
          <div className="mt-0.5 text-[11px] text-faint">Named, encrypted — rendered to a repo + path by a grant</div>
        </div>
        {canManage && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-sm border border-accent-line px-3 py-1.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent-soft"
          >
            <Plus size={13} /> Add secret
          </button>
        ) : null}
      </div>

      {names.length === 0 && !adding ? (
        <p className="mt-3.5 font-mono text-[12px] text-faint">No worktree secrets yet.</p>
      ) : (
        <ul className="mt-3.5 flex flex-col gap-2">
          {names.map((n) => (
            <li
              key={n}
              className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3.5 py-2.5"
            >
              <span className="flex-1 font-mono text-[12.5px] text-text">{n}</span>
              <span className="font-mono text-[12px] text-faint">{'•'.repeat(12)}</span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => void del.mutate(n)}
                  className="rounded-sm border border-border-2 p-1.5 text-faint transition hover:text-red"
                  aria-label={`Delete ${n}`}
                >
                  <Trash2 size={13} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="mt-3.5 flex flex-col gap-2 rounded-md border border-border-2 bg-surface-2 p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="secret name (e.g. dotenvxPrivateKeys)"
            className="rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12.5px] text-text outline-none placeholder:text-faint"
          />
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="secret value (stored encrypted)"
            rows={3}
            className="resize-y rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
          />
          {error ? <p className="text-[11.5px] text-red">{error}</p> : null}
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={submit}
              disabled={save.isPending}
              className="rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
              style={{ background: 'var(--accent)' }}
            >
              {save.isPending ? 'Saving…' : 'Save secret'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setName('');
                setValue('');
                setError('');
              }}
              className="rounded-md border border-border-2 px-3.5 py-2 text-[12px] font-medium text-dim transition hover:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Grants ────────────────────────────────────────────────────────────────────────────────────────
function GrantsCard({
  orgId,
  names,
  grants,
  canManage,
}: {
  orgId: string;
  names: string[];
  grants: WorktreeSecretGrant[];
  canManage: boolean;
}) {
  const { data: repos } = useOrgRepos(orgId);
  const grant = useGrantWorktreeSecret(orgId);
  const revoke = useRevokeWorktreeSecret(orgId);
  const [name, setName] = useState('');
  const [repoId, setRepoId] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');

  const repoName = (id: string) => repos?.find((r) => r.id === id)?.name ?? id;

  async function add() {
    if (!name || !repoId || !path.trim()) return setError('Pick a secret, a repo, and a path.');
    setError('');
    try {
      await grant.mutateAsync({ name, repoId, path: path.trim() });
      setPath('');
    } catch (e) {
      setError((e as Error)?.message || 'Could not grant.');
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-center gap-3">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-border-2 bg-surface-3 text-dim">
          <Shield size={16} />
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-text">Grants</div>
          <div className="mt-0.5 text-[11px] text-faint">Authorize a secret → repo → destination path</div>
        </div>
      </div>

      {grants.length === 0 ? (
        <p className="mt-3.5 font-mono text-[12px] text-faint">No grants — secrets won’t hydrate anywhere yet.</p>
      ) : (
        <ul className="mt-3.5 flex flex-col gap-2">
          {grants.map((g) => (
            <li
              key={`${g.repoId}:${g.name}:${g.path}`}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-[12px]"
            >
              <span className="text-text">{g.name}</span>
              <span className="text-faint">→</span>
              <span className="text-dim">{repoName(g.repoId)}</span>
              <span className="text-faint">:</span>
              <span className="flex-1 truncate text-dim">{g.path}</span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => void revoke.mutate(g)}
                  className="rounded-sm border border-border-2 p-1.5 text-faint transition hover:text-red"
                  aria-label="Revoke grant"
                >
                  <Trash2 size={13} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="mt-3.5 flex flex-col gap-2 rounded-md border border-border-2 bg-surface-2 p-3">
          <div className="flex gap-2">
            <select
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-md border border-border-2 bg-surface px-2.5 py-2 text-[12px] text-text outline-none"
            >
              <option value="">secret…</option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="flex-1 rounded-md border border-border-2 bg-surface px-2.5 py-2 text-[12px] text-text outline-none"
            >
              <option value="">repo…</option>
              {(repos ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="destination path (e.g. .env.keys) — must be gitignored"
            className="rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12.5px] text-text outline-none placeholder:text-faint"
          />
          {error ? <p className="text-[11.5px] text-red">{error}</p> : null}
          <div>
            <button
              type="button"
              onClick={add}
              disabled={grant.isPending}
              className="rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
              style={{ background: 'var(--accent)' }}
            >
              {grant.isPending ? 'Granting…' : 'Add grant'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
