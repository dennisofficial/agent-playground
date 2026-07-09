"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Paperclip, Plug, Upload } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { BranchPicker, Dropdown } from "@/components/branch-picker";
import { useOrgs } from "@/lib/api/me";
import { useOrgRepos, useCreateThread } from "@/lib/api/job-queries";
import type { OperatorJobKind } from "@/lib/api/job-api";
import { useAttachments } from "@/features/job-workspace/use-attachments";
import { useFileDrop } from "@/features/job-workspace/use-file-drop";
import { AttachmentTray } from "@/features/job-workspace/attachment-tray";
import { orgSwatch, orgInitials } from "@/lib/org-display";
import { ROUTES, threadHref } from "@/lib/routes";

/**
 * Create-thread form — shared by the `@dialog` modal and the `/new` full-page fallback (single source).
 * Picks an org → a connected repo → a base branch, takes a required first message, and creates the thread
 * via `POST /web/orgs/:orgId/repos/:repoId/threads` (which injects the first message), then opens the new
 * thread workspace. Honest empty states when there are no orgs / the org has no connected repo.
 */
export function CreateThread({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const { orgs, isLoading: orgsLoading } = useOrgs();

  // Pre-selection from the sidebar's per-org / per-repo ＋ (`/new?org=…&repo=…`). Read from the router's
  // search params (NOT `window.location.search`) — on a `<Link>` navigation into the intercepted `/new`
  // modal, `window.location` still holds the PREVIOUS url during this render, so the preselect would come
  // back empty and the org/repo would wrongly fall back to the first one. `useSearchParams` reflects the
  // navigated-to route correctly; both call sites wrap this component in a `<Suspense>` boundary for it.
  const search = useSearchParams();
  const [preselect] = useState(() => ({
    org: search.get("org") ?? "",
    repo: search.get("repo") ?? "",
  }));

  const [orgId, setOrgId] = useState<string>(preselect.org);
  const [repoId, setRepoId] = useState<string>(preselect.repo);
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("");
  // Job kind — "" = auto (brain scopes it, the default). "review" reveals a PR-number field.
  const [kind, setKind] = useState<OperatorJobKind | "">("");
  const [prNumber, setPrNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const {
    attachments,
    error: attachError,
    add: addFiles,
    remove: removeAttachment,
    addPastedImages,
  } = useAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Drop files anywhere on the form → the same tray the ＋/paste feed. Always live in the modal.
  const { isDragging, dropHandlers } = useFileDrop(addFiles);

  // Default the org to the operator's first org (owned first, from the session order).
  useEffect(() => {
    if (orgId || orgs.length === 0) return;
    setOrgId(orgs[0].id);
  }, [orgs, orgId]);

  const { data: repos = [], isLoading: reposLoading } = useOrgRepos(orgId);
  const create = useCreateThread(orgId, repoId);

  // When the org (or its repo list) changes, default the repo + its base branch.
  useEffect(() => {
    // Don't clobber the preselected repo (`/new?repo=…`) while the list is still loading — `repos`
    // defaults to `[]` mid-fetch, which would otherwise reset `repoId` to '' before the real list lands.
    if (reposLoading) return;
    if (repos.length === 0) {
      setRepoId("");
      return;
    }
    const stillValid = repos.some((r) => r.id === repoId);
    const next = stillValid ? repos.find((r) => r.id === repoId)! : repos[0];
    if (!stillValid) setRepoId(next.id);
    setBranch((b) => b || next.defaultBranch || "main");
  }, [repos, repoId, reposLoading]);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === repoId),
    [repos, repoId],
  );

  if (orgsLoading) {
    return <p className="py-6 text-center text-[13px] text-faint">Loading…</p>;
  }
  if (orgs.length === 0) {
    return (
      <EmptyState
        title="Create an organization first"
        body="Jobs live under an organization's repos. Set up an org and connect a repo to start steering work."
      />
    );
  }

  function submit() {
    let text = message.trim();
    if (!orgId) return setError("Pick an organization.");
    if (!repoId) return setError("Pick a repo to start a job.");
    const isReview = kind === "review";
    const pr = prNumber.trim();
    if (isReview && !/^\d+$/.test(pr)) {
      return setError("Enter the PR number to review.");
    }
    // A review job needs no typed message — the <review> block carries the task. Synthesize a natural
    // first message so the brain has an instruction and the backend's "firstMessage or attachment" gate passes.
    if (isReview && !text) text = `Review PR #${pr}.`;
    if (!text && attachments.length === 0) {
      return setError("Add a first message or an attachment — it starts the job.");
    }
    setError(null);
    // Seed a title from the first line of the message so the thread isn't "Untitled" before the
    // brain renames it (the create endpoint takes an optional title).
    const title = text.split("\n")[0].trim().slice(0, 80) || undefined;
    create.mutate(
      {
        firstMessage: text,
        title,
        baseBranch: branch.trim() || undefined,
        ...(kind ? { kind } : {}),
        ...(isReview ? { prNumber: pr } : {}),
        ...(attachments.length
          ? { files: attachments.map((a) => a.file) }
          : {}),
      },
      {
        onSuccess: ({ jobId }) => {
          router.push(threadHref({ orgId, repoId, jobId }));
          onDone?.();
        },
        onError: () => setError("Could not start the job. Try again."),
      },
    );
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  return (
    <div className="relative flex flex-col gap-4" {...dropHandlers}>
      {/* Drag-over affordance — `pointer-events-none` so the drop still lands on the root's handlers. */}
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-accent/5 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-surface/90 px-6 py-4 text-[13px] font-medium text-accent shadow-lg">
            <Upload size={16} strokeWidth={2.2} />
            Drop files to attach
          </div>
        </div>
      ) : null}
      <div>
        <p className="text-[12px] font-medium text-dim">Organization</p>
        <div className="mt-1.5">
          <OrgPicker
            orgs={orgs}
            value={orgId}
            onChange={(id) => {
              setOrgId(id);
              setRepoId("");
              setBranch("");
            }}
          />
        </div>
      </div>

      <div>
        <p className="text-[12px] font-medium text-dim">Repo</p>
        {reposLoading ? (
          <p className="mt-1.5 text-[12px] text-faint">Loading repos…</p>
        ) : repos.length === 0 ? (
          <NoRepos orgId={orgId} onDone={onDone} />
        ) : (
          <>
            <div className="mt-1.5">
              <RepoPicker
                repos={repos}
                value={repoId}
                onChange={(id) => {
                  setRepoId(id);
                  setBranch(""); // re-default to the new repo's base branch (effect picks it up)
                }}
              />
            </div>
            {selectedRepo && !selectedRepo.accessOk ? (
              <p className="mt-1 font-mono text-[9.5px] text-red">
                repo access isn&apos;t validated yet — check the org credentials
              </p>
            ) : null}
          </>
        )}
      </div>

      {repos.length > 0 ? (
        <div>
          <p className="text-[12px] font-medium text-dim">Base branch</p>
          <div className="mt-1.5">
            <BranchPicker
              orgId={orgId}
              repoId={repoId}
              value={branch}
              onChange={setBranch}
              fallback={selectedRepo?.defaultBranch ?? "main"}
            />
          </div>
        </div>
      ) : null}

      {repos.length > 0 ? (
        <div>
          <p className="text-[12px] font-medium text-dim">Job type</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(
              [
                ["", "Auto"],
                ["feature", "Feature"],
                ["bugfix", "Bugfix"],
                ["review", "Review"],
              ] as [OperatorJobKind | "", string][]
            ).map(([value, label]) => (
              <button
                key={value || "auto"}
                type="button"
                onClick={() => setKind(value)}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-[12px] transition",
                  kind === value
                    ? "border-accent bg-[var(--accent-soft)] text-accent"
                    : "border-border-2 text-dim hover:bg-surface-2 hover:text-text",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {kind === "review" ? (
            <div className="mt-2">
              <input
                value={prNumber}
                onChange={(e) =>
                  setPrNumber(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder="PR number (e.g. 116)"
                className="w-full rounded-md border border-border-2 bg-surface px-3 py-2 text-[13px] text-text outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
              />
              <p className="mt-1 text-[11px] text-faint">
                Atlas fetches this PR and reviews the diff — no build, no PR of its own.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <p className="text-[12px] font-medium text-dim">
          First message
          {kind === "review" ? (
            <span className="ml-1 font-normal text-faint">(optional — the PR is already set)</span>
          ) : null}
        </p>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // ⌘+Enter (Mac) / Ctrl+Enter (Windows/Linux) submits, mirroring the Create thread button.
            // Plain Enter still inserts a newline. No-op while a create is in flight or there are no repos.
            const submitCombo =
              (e.metaKey || e.ctrlKey) && e.key === "Enter";
            if (!submitCombo) return;
            e.preventDefault();
            if (create.isPending || repos.length === 0) return;
            submit();
          }}
          onPaste={(e) => {
            if (addPastedImages(e)) e.preventDefault();
          }}
          rows={4}
          placeholder="Describe the work — sent as your first message the moment the job is ready…"
          className="mt-1.5 w-full resize-none rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md border border-border-2 px-2.5 py-1.5 text-[12px] text-dim transition hover:bg-surface-2 hover:text-text"
          >
            <Paperclip size={13} strokeWidth={2} />
            Attach files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.css,.js,.ts,.tsx"
            className="hidden"
            onChange={onPick}
          />
        </div>
        <AttachmentTray
          attachments={attachments}
          onRemove={removeAttachment}
          className="mt-2"
        />
        {attachError ? (
          <p className="mt-1.5 text-[12px] text-red">{attachError}</p>
        ) : null}
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
              style={{ background: orgSwatch() }}
            >
              {orgInitials(selected.name)}
            </span>
          ) : null}
          <span className="flex-1 truncate text-left text-[12.5px] text-text">
            {selected?.name ?? "Select an org"}
          </span>
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
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2",
              o.id === value ? "text-text" : "text-dim",
            )}
          >
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded font-disp text-[8px] font-semibold text-white"
              style={{ background: orgSwatch() }}
            >
              {orgInitials(o.name)}
            </span>
            <span className="flex-1 truncate">{o.name}</span>
            <Check
              size={12}
              className={o.id === value ? "text-accent" : "opacity-0"}
            />
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
        trigger={
          <span className="flex-1 truncate text-left font-mono text-[11.5px] text-text">
            {selected?.name ?? "Select a repo"}
          </span>
        }
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
                "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-surface-2",
                r.id === value ? "text-text" : "text-dim",
              )}
            >
              <Check
                size={12}
                className={r.id === value ? "text-accent" : "opacity-0"}
              />
              <span className="truncate">{r.name}</span>
            </button>
          ))
        }
      </Dropdown>
    </div>
  );
}

function NoRepos({ orgId, onDone }: { orgId: string; onDone?: () => void }) {
  return (
    <div className="mt-1.5 flex flex-col items-center rounded-md border border-dashed border-border-2 px-5 py-8 text-center">
      <span
        className="flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: "var(--surface-2)" }}
      >
        <Plug size={17} className="text-dim" />
      </span>
      <h3 className="mt-2.5 text-[13.5px] font-semibold text-text">
        Connect a repo first
      </h3>
      <p className="mt-1 max-w-xs text-[12px] text-dim">
        This organization has no connected repository yet. Connect one in
        settings, then start a thread.
      </p>
      <Link
        href={ROUTES.orgSettings(orgId, "repos")}
        onClick={onDone}
        className="mt-3 rounded-md border px-3 py-1.5 text-[12px] font-medium text-accent"
        style={{
          background: "var(--accent-soft)",
          borderColor: "var(--accent-line)",
        }}
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
