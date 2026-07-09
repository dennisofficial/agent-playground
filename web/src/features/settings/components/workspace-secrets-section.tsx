"use client";

import { useState } from "react";
import { FileKey, Plus, Trash2 } from "lucide-react";
import {
  useDeleteWorkspaceSecretFile,
  useSaveWorkspaceSecretFile,
  useWorkspaceSecrets,
  type WorkspaceSecretFile,
} from "@/lib/api/orgs";
import { useOrgRepos } from "@/lib/api/job-queries";

/**
 * Workspace secret files — per-repo, encrypted files (`.env`, `.env.keys`, a service-account JSON, …) the
 * worktree hydrator renders into a thread's sandbox. The list is refs-only (repo + path + label; values
 * are never returned). One entry IS the value AND the authority: a file renders only where an owner has
 * added it, for a specific repo + destination path (workspace config — mounts — is a separate, DB-backed
 * record and never carries secrets; see docs/adr/0003-worktree-config-db-not-git.md). Files are added
 * here, or during repo onboarding by the secure secret/file prompt. Owner-only writes (the server
 * enforces it; members get a read-only view).
 */
export function WorkspaceSecretsSection({
  orgId,
  role,
}: {
  orgId: string;
  role: string;
}) {
  const { data, isLoading, isError } = useWorkspaceSecrets(orgId);
  const isOwner = role === "owner";

  if (isLoading)
    return <p className="text-[13px] text-faint">Loading workspace secrets…</p>;
  if (isError || !data)
    return (
      <p className="text-[13px] text-red">Couldn’t load workspace secrets.</p>
    );

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
        Workspace secrets
      </h1>
      <p className="mb-7 mt-1.5 text-[13px] leading-relaxed text-dim">
        Encrypted files the build renders into a thread’s sandbox for a specific
        repo and path (e.g.{" "}
        <code className="font-mono text-[12px]">.env.keys</code>). Encrypted at
        rest — values are never shown. A file only exists where you add it; the
        entry itself is the authority (separate, DB-backed workspace config
        carries mounts only, never secrets). The destination must be gitignored.
        Atlas also adds these for you during repo onboarding.
      </p>

      {!isOwner ? (
        <div className="mb-5 rounded-md border border-border-2 bg-surface-2 px-3.5 py-2.5 text-[12px] text-dim">
          Only org owners can manage workspace secret files.
        </div>
      ) : null}

      <SecretFilesCard orgId={orgId} files={data.files} canManage={isOwner} />
    </>
  );
}

function SecretFilesCard({
  orgId,
  files,
  canManage,
}: {
  orgId: string;
  files: WorkspaceSecretFile[];
  canManage: boolean;
}) {
  const { data: repos } = useOrgRepos(orgId);
  const save = useSaveWorkspaceSecretFile(orgId);
  const del = useDeleteWorkspaceSecretFile(orgId);
  const [adding, setAdding] = useState(false);
  const [repoId, setRepoId] = useState("");
  const [path, setPath] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");

  const repoName = (id: string) => repos?.find((r) => r.id === id)?.name ?? id;

  const sorted = [...files].sort(
    (a, b) =>
      repoName(a.repoId).localeCompare(repoName(b.repoId)) ||
      a.path.localeCompare(b.path),
  );

  async function submit() {
    if (!repoId) return setError("Pick a repo.");
    const p = path.trim();
    if (!p) return setError("Enter a destination path.");
    if (!value) return setError("Enter a value.");
    setError("");
    try {
      await save.mutateAsync({
        repoId,
        path: p,
        value,
        label: label.trim() || undefined,
      });
      setAdding(false);
      setRepoId("");
      setPath("");
      setValue("");
      setLabel("");
    } catch (e) {
      setError((e as Error)?.message || "Could not save.");
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-center gap-3">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-border-2 bg-surface-3 text-dim">
          <FileKey size={16} />
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-text">
            Secret files
          </div>
          <div className="mt-0.5 text-[11px] text-faint">
            Encrypted — rendered to a repo + destination path
          </div>
        </div>
        {canManage && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-sm border border-accent-line px-3 py-1.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent-soft"
          >
            <Plus size={13} /> Add file
          </button>
        ) : null}
      </div>

      {sorted.length === 0 && !adding ? (
        <p className="mt-3.5 font-mono text-[12px] text-faint">
          No workspace secret files yet.
        </p>
      ) : (
        <ul className="mt-3.5 flex flex-col gap-2">
          {sorted.map((f) => (
            <li
              key={`${f.repoId}:${f.path}`}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-[12px]"
            >
              <span className="text-dim">{repoName(f.repoId)}</span>
              <span className="text-faint">:</span>
              <span className="truncate text-text">{f.path}</span>
              {f.label ? (
                <span className="truncate text-faint">({f.label})</span>
              ) : null}
              <span className="ml-auto text-faint">{"•".repeat(10)}</span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() =>
                    void del.mutate({ repoId: f.repoId, path: f.path })
                  }
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
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="label (optional, e.g. STRIPE_KEY)"
              className="flex-1 rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
            />
          </div>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="destination path (e.g. .env.keys) — must be gitignored"
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
              style={{ background: "var(--accent)" }}
            >
              {save.isPending ? "Saving…" : "Save file"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setRepoId("");
                setPath("");
                setValue("");
                setLabel("");
                setError("");
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
