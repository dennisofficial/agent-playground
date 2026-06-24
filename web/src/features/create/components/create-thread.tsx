'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronDown, GitBranch, Plug } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { useOrgFilter } from '@/components/providers/orgs-provider';
import { useOrgRepos, useCreateThread } from '@/lib/api/thread-queries';
import { orgColor, orgInitials } from '@/lib/org-display';
import { ROUTES, threadHref } from '@/lib/routes';

/**
 * Create-thread form — shared by the `@dialog` modal and the `/new` full-page fallback (single source).
 * Picks an org → a connected repo → a base branch, takes a required first message, and creates the thread
 * via `POST /web/orgs/:orgId/repos/:repoId/threads` (which injects the first message), then opens the new
 * thread workspace. Honest empty states when there are no orgs / the org has no connected repo.
 */
export function CreateThread({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const { filter, orgs, isLoading: orgsLoading } = useOrgFilter();

  const [orgId, setOrgId] = useState<string>('');
  const [repoId, setRepoId] = useState<string>('');
  const [branch, setBranch] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Default the org to the current rail filter (if a single org is selected), else the first org.
  useEffect(() => {
    if (orgId || orgs.length === 0) return;
    const initial = filter !== 'all' && orgs.some((o) => o.id === filter) ? filter : orgs[0].id;
    setOrgId(initial);
  }, [orgs, filter, orgId]);

  const { data: repos = [], isLoading: reposLoading } = useOrgRepos(orgId);
  const create = useCreateThread(orgId, repoId);

  // When the org (or its repo list) changes, default the repo + its base branch.
  useEffect(() => {
    if (repos.length === 0) {
      setRepoId('');
      return;
    }
    const stillValid = repos.some((r) => r.id === repoId);
    const next = stillValid ? repos.find((r) => r.id === repoId)! : repos[0];
    if (!stillValid) setRepoId(next.id);
    setBranch((b) => b || next.defaultBranch || 'main');
  }, [repos, repoId]);

  const selectedRepo = useMemo(() => repos.find((r) => r.id === repoId), [repos, repoId]);

  if (orgsLoading) {
    return <p className="py-6 text-center text-[13px] text-faint">Loading…</p>;
  }
  if (orgs.length === 0) {
    return (
      <EmptyState
        title="Create an organization first"
        body="Threads live under an organization's repos. Set up an org and connect a repo to start steering work."
      />
    );
  }

  function submit() {
    const text = message.trim();
    if (!orgId) return setError('Pick an organization.');
    if (!repoId) return setError('Pick a repo to start a thread.');
    if (!text) return setError('Add a first message — it starts the thread.');
    setError(null);
    // Seed a title from the first line of the message so the thread isn't "Untitled" before the
    // brain renames it (the create endpoint takes an optional title).
    const title = text.split('\n')[0].trim().slice(0, 80) || undefined;
    create.mutate(
      { firstMessage: text, title, baseBranch: branch.trim() || undefined },
      {
        onSuccess: ({ threadId }) => {
          router.push(threadHref({ orgId, repoId, threadId }));
          onDone?.();
        },
        onError: () => setError('Could not start the thread. Try again.'),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[12px] font-medium text-dim">Organization</p>
        <div className="mt-1.5">
          <OrgPicker
            orgs={orgs}
            value={orgId}
            onChange={(id) => {
              setOrgId(id);
              setRepoId('');
              setBranch('');
            }}
          />
        </div>
      </div>

      <div>
        <p className="text-[12px] font-medium text-dim">Repo &amp; base branch</p>
        {reposLoading ? (
          <p className="mt-1.5 text-[12px] text-faint">Loading repos…</p>
        ) : repos.length === 0 ? (
          <NoRepos orgId={orgId} onDone={onDone} />
        ) : (
          <>
            <div className="mt-1.5 flex gap-2">
              <RepoPicker repos={repos} value={repoId} onChange={setRepoId} />
              <div className="flex h-10 items-center gap-1.5 rounded-md border border-border-2 bg-surface px-2.5">
                <GitBranch size={13} className="text-faint" />
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="w-28 bg-transparent font-mono text-[11.5px] text-text outline-none"
                  aria-label="Base branch"
                  placeholder={selectedRepo?.defaultBranch ?? 'main'}
                />
              </div>
            </div>
            {selectedRepo && !selectedRepo.accessOk ? (
              <p className="mt-1 font-mono text-[9.5px] text-red">
                repo access isn&apos;t validated yet — check the org credentials
              </p>
            ) : null}
          </>
        )}
      </div>

      <div>
        <p className="text-[12px] font-medium text-dim">First message</p>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="Describe the work — sent as your first message the moment the thread is ready…"
          className="mt-1.5 w-full resize-none rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
        />
      </div>

      {error ? <p className="text-[12px] text-red">{error}</p> : null}

      <div className="flex justify-end">
        <Button
          onClick={submit}
          loading={create.isPending}
          loadingText="Starting…"
          disabled={repos.length === 0}
        >
          Create thread
        </Button>
      </div>
    </div>
  );
}

function OrgPicker({
  orgs,
  value,
  onChange,
}: {
  orgs: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const selected = orgs.find((o) => o.id === value);
  return (
    <Dropdown
      trigger={
        <>
          {selected ? (
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded font-disp text-[8px] font-semibold text-white"
              style={{ background: orgColor(selected.id) }}
            >
              {orgInitials(selected.name)}
            </span>
          ) : null}
          <span className="flex-1 truncate text-left text-[12.5px] text-text">{selected?.name ?? 'Select an org'}</span>
        </>
      }
    >
      {(close) =>
        orgs.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => {
              onChange(o.id);
              close();
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2',
              o.id === value ? 'text-text' : 'text-dim',
            )}
          >
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded font-disp text-[8px] font-semibold text-white"
              style={{ background: orgColor(o.id) }}
            >
              {orgInitials(o.name)}
            </span>
            <span className="flex-1 truncate">{o.name}</span>
            <Check size={12} className={o.id === value ? 'text-accent' : 'opacity-0'} />
          </button>
        ))
      }
    </Dropdown>
  );
}

function RepoPicker({
  repos,
  value,
  onChange,
}: {
  repos: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const selected = repos.find((r) => r.id === value);
  return (
    <div className="flex-1">
      <Dropdown
        trigger={<span className="flex-1 truncate text-left font-mono text-[11.5px] text-text">{selected?.name ?? 'Select a repo'}</span>}
      >
        {(close) =>
          repos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onChange(r.id);
                close();
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-surface-2',
                r.id === value ? 'text-text' : 'text-dim',
              )}
            >
              <Check size={12} className={r.id === value ? 'text-accent' : 'opacity-0'} />
              <span className="truncate">{r.name}</span>
            </button>
          ))
        }
      </Dropdown>
    </div>
  );
}

/** A small click-away dropdown (trigger button + a render-prop menu). */
function Dropdown({
  trigger,
  children,
}: {
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center gap-2 rounded-md border border-border-2 bg-surface px-3"
      >
        {trigger}
        <ChevronDown size={13} className="shrink-0 text-faint" />
      </button>
      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function NoRepos({ orgId, onDone }: { orgId: string; onDone?: () => void }) {
  return (
    <div className="mt-1.5 flex flex-col items-center rounded-md border border-dashed border-border-2 px-5 py-8 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: 'var(--surface-2)' }}>
        <Plug size={17} className="text-dim" />
      </span>
      <h3 className="mt-2.5 text-[13.5px] font-semibold text-text">Connect a repo first</h3>
      <p className="mt-1 max-w-xs text-[12px] text-dim">
        This organization has no connected repository yet. Connect one in settings, then start a thread.
      </p>
      <Link
        href={ROUTES.orgSettings(orgId, 'repos')}
        onClick={onDone}
        className="mt-3 rounded-md border px-3 py-1.5 text-[12px] font-medium text-accent"
        style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
      >
        Open Repos settings
      </Link>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center rounded-md border border-dashed border-border-2 px-5 py-10 text-center">
      <h3 className="text-[14px] font-semibold text-text">{title}</h3>
      <p className="mt-1.5 max-w-xs text-[12.5px] text-dim">{body}</p>
    </div>
  );
}
