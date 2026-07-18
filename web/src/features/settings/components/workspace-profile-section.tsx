'use client';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputCls } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { useOrgRepos } from '@/lib/api/job-queries';
import {
  useDeleteMount,
  useDeleteRepoSecretFile,
  useSaveMount,
  useSavePreviewRecipe,
  useSaveRepoSecretFile,
  useSaveSetupScript,
  useWorkspaceProfile,
  type WorkspaceProfileMount,
  type WorkspaceProfileView,
} from '@/lib/api/orgs';
import { AlertCircle, Check, FileKey, Package, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

type Flash = { tone: 'green' | 'red'; text: string };

const RED_SOFT = 'color-mix(in srgb, var(--red) 8%, transparent)';
const RED_BORDER = 'color-mix(in srgb, var(--red) 40%, transparent)';
const GREEN_BORDER = 'color-mix(in srgb, var(--green) 32%, transparent)';

/**
 * Workspace profile — the Atlas-managed per-repo provisioning surface: encrypted secret files, extra
 * host mounts, a setup script, and a preview recipe, all reused from the same DB rows the onboarding
 * brain's `write_workspace_config` tool writes through, plus a read-only view of the dependency
 * manifests Atlas has acknowledged for this repo. Repo-scoped (one profile per repo), so the section
 * opens on a repo picker; reads are member-visible, every write is owner-only.
 */
export function WorkspaceProfileSection({ orgId, role }: { orgId: string; role: string }) {
  const { data: repos } = useOrgRepos(orgId);
  const [repoId, setRepoId] = useState('');
  const canManage = role === 'owner';

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
        Workspace profile
      </h1>
      <p className="mb-7 mt-1.5 max-w-[640px] text-[13px] leading-relaxed text-dim">
        The Atlas-managed provisioning a repo’s sandboxes are built from — secret files, mounts, a
        setup script, and a preview recipe — plus the dependency manifests Atlas has detected. Pick
        a repo below.
      </p>

      {!canManage ? (
        <div className="mb-5 rounded-md border border-border-2 bg-surface-2 px-3.5 py-2.5 text-[12px] text-dim">
          Only org owners can edit a repo’s workspace profile.
        </div>
      ) : null}

      <div className="mb-5 flex items-center gap-2.5">
        <span className="font-mono text-[9px] tracking-[0.1em] text-faint">REPO</span>
        <select
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
          className="max-w-[320px] flex-1 rounded-md border border-border-2 bg-surface-2 px-3 py-2 font-mono text-[12.5px] font-semibold text-text outline-none"
        >
          <option value="">Pick a repo…</option>
          {(repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      {!repoId ? (
        <p className="text-[12px] text-faint">
          Pick a repo to view and edit its workspace profile.
        </p>
      ) : (
        <RepoProfile key={repoId} orgId={orgId} repoId={repoId} canManage={canManage} />
      )}
    </>
  );
}

// ── The hub: renders a fixed registry of sections from the loaded profile ──────────────────────────
type ProfileCtx = {
  orgId: string;
  repoId: string;
  data: WorkspaceProfileView;
  canManage: boolean;
};
type ProfileSection = {
  id: string;
  title: string;
  subtitle?: string;
  render: (ctx: ProfileCtx) => ReactNode;
};

const SECTIONS: ProfileSection[] = [
  {
    id: 'secret-files',
    title: 'Secret files',
    subtitle: 'Encrypted — rendered to this repo at a destination path',
    render: (c) => <SecretFilesSection {...c} />,
  },
  {
    id: 'mounts',
    title: 'Mounts',
    subtitle: 'Extra host directories bound into this repo’s sandboxes',
    render: (c) => <MountsSection {...c} />,
  },
  {
    id: 'setup-script',
    title: 'Setup script',
    subtitle: 'Runs on every cold sandbox bring-up; must be idempotent',
    render: (c) => <SetupScriptSection {...c} />,
  },
  {
    id: 'preview-recipe',
    title: 'Preview recipe',
    subtitle: 'How Atlas stands up this repo’s preview stack',
    render: (c) => <PreviewRecipeSection {...c} />,
  },
  {
    id: 'detected-stack',
    title: 'Detected stack',
    subtitle: 'Dependency manifests this profile has acknowledged',
    render: (c) => <DetectedStackSection {...c} />,
  },
];

function RepoProfile({
  orgId,
  repoId,
  canManage,
}: {
  orgId: string;
  repoId: string;
  canManage: boolean;
}) {
  const { data, isLoading, isError, refetch } = useWorkspaceProfile(orgId, repoId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-faint">
        <Spinner className="h-3 w-3" /> Loading workspace profile…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div
        className="flex items-start gap-3 rounded-lg p-[22px]"
        style={{
          background: RED_SOFT,
          border: `1px solid color-mix(in srgb, var(--red) 30%, transparent)`,
        }}
      >
        <AlertCircle size={17} className="mt-0.5 shrink-0 text-red" />
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-red">
            Couldn’t load this repo’s workspace profile.
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-dim">
            The server didn’t respond. Check your connection and try again.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          className="shrink-0 rounded-md border border-border-2 bg-surface px-3.5 py-2 text-[12px] font-semibold text-text transition hover:bg-surface-2"
        >
          Retry
        </button>
      </div>
    );
  }

  const ctx: ProfileCtx = { orgId, repoId, data, canManage };
  return (
    <div className="flex flex-col gap-5">
      {SECTIONS.map((s) => (
        <Card key={s.id} className="p-[18px]">
          <div className="mb-3.5">
            <div className="text-[13.5px] font-semibold text-text">{s.title}</div>
            {s.subtitle ? <div className="mt-0.5 text-[11px] text-faint">{s.subtitle}</div> : null}
          </div>
          {s.render(ctx)}
        </Card>
      ))}
    </div>
  );
}

// ── A local success/error flash — clears itself after ~4s ──────────────────────────────────────────
function useFlash() {
  const [flash, setFlash] = useState<Flash | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4200);
    return () => clearTimeout(t);
  }, [flash]);
  return [flash, setFlash] as const;
}

function Flasher({ flash }: { flash: Flash | null }) {
  if (!flash) return null;
  const ok = flash.tone === 'green';
  return (
    <div
      className="mb-3.5 flex items-center gap-2.5 rounded-md px-3.5 py-2.5"
      style={{
        background: ok ? 'var(--green-soft)' : RED_SOFT,
        border: `1px solid ${ok ? GREEN_BORDER : RED_BORDER}`,
      }}
    >
      {ok ? (
        <Check size={14} strokeWidth={2.2} style={{ color: 'var(--green)' }} />
      ) : (
        <AlertCircle size={14} strokeWidth={2} style={{ color: 'var(--red)' }} />
      )}
      <span
        className="text-[12px] font-medium"
        style={{ color: ok ? 'var(--green)' : 'var(--red)' }}
      >
        {flash.text}
      </span>
    </div>
  );
}

// ── Secret files ──────────────────────────────────────────────────────────────────────────────────
function SecretFilesSection({ orgId, repoId, data, canManage }: ProfileCtx) {
  const save = useSaveRepoSecretFile(orgId, repoId);
  const del = useDeleteRepoSecretFile(orgId, repoId);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const files = [...data.secretFiles].sort((a, b) => a.path.localeCompare(b.path));

  function resetForm() {
    setAdding(false);
    setPath('');
    setLabel('');
    setValue('');
    setError('');
  }

  async function submit() {
    const p = path.trim();
    if (!p) return setError('Enter a destination path.');
    if (!value) return setError('Enter a value.');
    setError('');
    try {
      await save.mutateAsync({
        path: p,
        value,
        label: label.trim() || undefined,
      });
      resetForm();
    } catch (e) {
      setError((e as Error)?.message || 'Could not save.');
    }
  }

  return (
    <>
      {canManage && !adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mb-3.5 flex items-center gap-1.5 rounded-sm border border-accent-line px-3 py-1.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent-soft"
        >
          <Plus size={13} /> Add file
        </button>
      ) : null}

      {files.length === 0 && !adding ? (
        <p className="font-mono text-[12px] text-faint">No secret files for this repo yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((f) => (
            <li
              key={f.path}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-[12px]"
            >
              <FileKey size={13} className="shrink-0 text-faint" />
              <span className="truncate text-text">{f.path}</span>
              {f.label ? <span className="truncate text-faint">({f.label})</span> : null}
              <span className="ml-auto text-faint">{'•'.repeat(10)}</span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => void del.mutate({ path: f.path })}
                  className="rounded-sm border border-border-2 p-1.5 text-faint transition hover:text-red"
                  aria-label={`Delete ${f.path}`}
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
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="destination path (e.g. .env.keys) — must be gitignored"
              className="flex-1 rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12.5px] text-text outline-none placeholder:text-faint"
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="label (optional)"
              className="w-[180px] rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
            />
          </div>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="secret value (stored encrypted)"
            rows={3}
            className="resize-y rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
          />
          {error ? <p className="text-[11.5px] text-red">{error}</p> : null}
          <div className="flex gap-2.5">
            <Button size="sm" onClick={submit} loading={save.isPending} loadingText="Saving…">
              Save file
            </Button>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ── Mounts ────────────────────────────────────────────────────────────────────────────────────────
const MOUNT_MODES: WorkspaceProfileMount['mode'][] = ['per-thread', 'shared-ro', 'shared-rw'];

function MountsSection({ orgId, repoId, data, canManage }: ProfileCtx) {
  const save = useSaveMount(orgId, repoId);
  const del = useDeleteMount(orgId, repoId);
  const [flash, setFlash] = useFlash();
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<WorkspaceProfileMount['mode']>('per-thread');
  const [error, setError] = useState('');

  const mounts = [...data.mounts].sort((a, b) => a.path.localeCompare(b.path));
  const RESTART_NOTE = 'sandboxes recreate on their next attach to pick this up.';

  function onDelete(p: string) {
    del.mutate(
      { path: p },
      {
        onSuccess: () =>
          setFlash({
            tone: 'green',
            text: `Removed mount ${p} — ${RESTART_NOTE}`,
          }),
        onError: (e) =>
          setFlash({
            tone: 'red',
            text: (e as Error)?.message || 'Could not remove the mount.',
          }),
      },
    );
  }

  async function submit() {
    const p = path.trim();
    if (!p) return setError('Enter a mount path.');
    setError('');
    try {
      await save.mutateAsync(
        { path: p, mode },
        {
          onSuccess: () =>
            setFlash({
              tone: 'green',
              text: `Saved mount ${p} — ${RESTART_NOTE}`,
            }),
        },
      );
      setAdding(false);
      setPath('');
      setMode('per-thread');
    } catch (e) {
      setError((e as Error)?.message || 'Could not save.');
    }
  }

  return (
    <>
      <p className="mb-3.5 text-[11px] leading-relaxed text-faint">
        Changing mounts recreates in-flight sandboxes on their next attach.
      </p>

      <Flasher flash={flash} />

      {canManage && !adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mb-3.5 flex items-center gap-1.5 rounded-sm border border-accent-line px-3 py-1.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent-soft"
        >
          <Plus size={13} /> Add mount
        </button>
      ) : null}

      {mounts.length === 0 && !adding ? (
        <p className="font-mono text-[12px] text-faint">No extra mounts for this repo.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mounts.map((m) => (
            <li
              key={m.path}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-[12px]"
            >
              <span className="truncate text-text">{m.path}</span>
              <span className="ml-auto rounded-full border border-border-2 bg-surface-3 px-2 py-0.5 font-mono text-[9.5px] text-dim">
                {m.mode}
              </span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => onDelete(m.path)}
                  className="rounded-sm border border-border-2 p-1.5 text-faint transition hover:text-red"
                  aria-label={`Remove ${m.path}`}
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
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="mount path (e.g. .cache or /root/.config/gcloud)"
              className="flex-1 rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12.5px] text-text outline-none placeholder:text-faint"
            />
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as WorkspaceProfileMount['mode'])}
              className="rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12px] text-text outline-none"
            >
              {MOUNT_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {error ? <p className="text-[11.5px] text-red">{error}</p> : null}
          <div className="flex gap-2.5">
            <Button size="sm" onClick={submit} loading={save.isPending} loadingText="Saving…">
              Save mount
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setPath('');
                setMode('per-thread');
                setError('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ── Setup script / Preview recipe (shared textarea shape) ───────────────────────────────────────────
function ScriptEditor({
  value: seeded,
  onSave,
  onClear,
  saving,
  canManage,
  placeholder,
  helper,
}: {
  value: string | null;
  onSave: (script: string) => Promise<unknown>;
  onClear: () => Promise<unknown>;
  saving: boolean;
  canManage: boolean;
  placeholder: string;
  helper: string;
}) {
  const [value, setValue] = useState(seeded ?? '');
  const savedRef = useRef(seeded ?? '');
  const dirty = value !== savedRef.current;
  const [error, setError] = useState('');

  useEffect(() => {
    const next = seeded ?? '';
    // Re-sync from a refetch/reload, but never clobber an in-progress edit.
    if (value === savedRef.current) setValue(next);
    savedRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded]);

  async function save() {
    setError('');
    try {
      await onSave(value);
      savedRef.current = value;
    } catch (e) {
      setError((e as Error)?.message || 'Could not save.');
    }
  }

  async function clear() {
    setError('');
    try {
      await onClear();
      savedRef.current = '';
      setValue('');
    } catch (e) {
      setError((e as Error)?.message || 'Could not clear.');
    }
  }

  return (
    <>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={!canManage}
        placeholder={placeholder}
        rows={7}
        className={`${inputCls} h-auto resize-y py-2.5 font-mono text-[12.5px] leading-relaxed disabled:opacity-70`}
      />
      <p className="mt-1.5 text-[11px] leading-relaxed text-faint">{helper}</p>
      {error ? <p className="mt-1.5 text-[11.5px] text-red">{error}</p> : null}
      {canManage ? (
        <div className="mt-3 flex gap-2.5">
          <Button size="sm" onClick={save} disabled={!dirty} loading={saving} loadingText="Saving…">
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={clear} disabled={saving || value.length === 0}>
            Clear
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SetupScriptSection({ orgId, repoId, data, canManage }: ProfileCtx) {
  const save = useSaveSetupScript(orgId, repoId);
  return (
    <ScriptEditor
      value={data.setupScript}
      onSave={(script) => save.mutateAsync({ script })}
      onClear={() => save.mutateAsync({ script: null })}
      saving={save.isPending}
      canManage={canManage}
      placeholder={'#!/usr/bin/env bash\nset -euo pipefail\n\npnpm install'}
      helper="Runs on every cold sandbox bring-up; must be idempotent."
    />
  );
}

function PreviewRecipeSection({ orgId, repoId, data, canManage }: ProfileCtx) {
  const save = useSavePreviewRecipe(orgId, repoId);
  return (
    <ScriptEditor
      value={data.previewRecipe}
      onSave={(instructions) => save.mutateAsync({ instructions })}
      onClear={() => save.mutateAsync({ instructions: null })}
      saving={save.isPending}
      canManage={canManage}
      placeholder="e.g. run `pnpm dev` and expose port 3000"
      helper="How Atlas stands up this repo’s preview stack."
    />
  );
}

// ── Detected stack (read-only) ───────────────────────────────────────────────────────────────────
function DetectedStackSection({ data }: ProfileCtx) {
  const manifests = data.seenManifests ?? [];
  return (
    <>
      {manifests.length === 0 ? (
        <p className="font-mono text-[12px] text-faint">Not yet seeded.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {manifests.map((m) => (
            <span
              key={m}
              className="flex items-center gap-1.5 rounded-sm border border-border-2 bg-surface-2 px-2 py-1 font-mono text-[11px] text-dim"
            >
              <Package size={11} className="text-faint" />
              {m}
            </span>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        Live drift needs a running sandbox, so it isn’t computed here — this is the acknowledged
        manifest set.
      </p>
    </>
  );
}
