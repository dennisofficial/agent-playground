"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  GitBranch,
  Lock,
  MessageSquare,
  Plus,
  Power,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { AUTO_MERGE_METHODS, type AutoMergeMethod } from "@workspace/shared";
import { cn } from "@/lib/cn";
import { threadHref, type SettingsSection } from "@/lib/routes";
import { BranchPicker } from "@/components/branch-picker";
import { Spinner } from "@/components/ui/spinner";
import { useOrgRepos } from "@/lib/api/job-queries";
import type { RepoView } from "@/lib/api/job-api";
import {
  useOrgCredentials,
  useConnectRepo,
  useRevalidateRepo,
  useReonboardRepo,
  useUpdateRepo,
  useDisconnectRepo,
} from "@/lib/api/orgs";

/** HTTPS GitHub URL — same shape the backend's `parseGithubRepoUrl` accepts. */
const GITHUB_URL =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const RED_SOFT = "color-mix(in srgb, var(--red) 8%, transparent)";
const RED_BORDER = "color-mix(in srgb, var(--red) 40%, transparent)";
const GREEN_BORDER = "color-mix(in srgb, var(--green) 32%, transparent)";

type Flash = { tone: "green" | "red"; text: string };

/**
 * Repos — the GitHub repositories connected to the org. Owners can connect, re-validate, edit metadata,
 * and disconnect; members see a read-only list. Mirrors the credentials/members sections (this renders
 * inside the shared settings content column). Every write hits the live `/web/orgs/:orgId/repos*` API and
 * invalidates `qk.orgRepos` so the enriched list (thread-count + last-checked) refetches.
 */
export function ReposSection({
  orgId,
  orgName,
  role,
  onNavigate,
}: {
  orgId: string;
  orgName: string;
  role: string;
  onNavigate: (section: SettingsSection) => void;
}) {
  const { data: repos = [], isLoading, isError, refetch } = useOrgRepos(orgId);
  const { data: creds } = useOrgCredentials(orgId);
  const hasGithub = !!creds?.hasGithub;
  const canManage = role === "owner";
  const isMember = !canManage;

  const [formOpen, setFormOpen] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<RepoView | null>(
    null,
  );

  const revalidate = useRevalidateRepo(orgId);
  const reonboard = useReonboardRepo(orgId);
  const router = useRouter();

  // Auto-clear the success/error flash.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4200);
    return () => clearTimeout(t);
  }, [flash]);

  const isEmpty = !isLoading && !isError && repos.length === 0;

  function onRevalidate(repoId: string) {
    if (revalidate.isPending) return;
    revalidate.mutate(repoId, {
      onError: (e) =>
        setFlash({
          tone: "red",
          text: (e as Error)?.message || "Re-validation failed.",
        }),
    });
  }

  function onReonboard(repo: RepoView) {
    if (reonboard.isPending) return;
    reonboard.mutate(repo.id, {
      onSuccess: ({ jobId }) => {
        setFlash({
          tone: "green",
          text: `Atlas is onboarding ${repo.name} — opening the job…`,
        });
        router.push(threadHref({ orgId, repoId: repo.id, jobId }));
      },
      onError: (e) =>
        setFlash({
          tone: "red",
          text: (e as Error)?.message || "Could not start onboarding.",
        }),
    });
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3.5">
        <div className="min-w-0 flex-1">
          <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
            Repos
          </h1>
          <p className="mt-1.5 text-[13px] text-dim">
            GitHub repositories connected to {orgName}. Jobs run on these.
          </p>
        </div>
        {canManage && repos.length > 0 && !formOpen ? (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105"
            style={{
              background: "var(--accent)",
              boxShadow: "0 4px 14px var(--accent-soft)",
            }}
          >
            <Plus size={14} strokeWidth={2.1} />
            Connect repo
          </button>
        ) : null}
      </div>

      <div className="h-6" />

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isEmpty ? (
        hasGithub ? (
          <>
            <EmptyCard withToken />
            {canManage ? (
              <ConnectForm
                orgId={orgId}
                cancelable={false}
                onConnected={setFlash}
                onCancel={() => setFormOpen(false)}
              />
            ) : null}
            <Flasher flash={flash} />
          </>
        ) : (
          <NoTokenState onOpenCredentials={() => onNavigate("credentials")} />
        )
      ) : (
        <>
          {isMember ? (
            <div className="mb-3 flex items-center gap-1.5 text-[11.5px] text-faint">
              <Lock size={13} />
              Read-only — only owners can connect, re-validate, edit, or
              disconnect repos.
            </div>
          ) : null}

          {canManage && formOpen ? (
            <ConnectForm
              orgId={orgId}
              cancelable
              onConnected={(f) => {
                setFlash(f);
                setFormOpen(false);
              }}
              onCancel={() => setFormOpen(false)}
            />
          ) : null}

          <Flasher flash={flash} />

          {/* List */}
          <div className="overflow-hidden rounded-lg border border-border">
            <div
              className="flex items-center px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint"
              style={{
                background: "var(--surface-2)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span className="flex-1">Repository</span>
              <span>Access</span>
            </div>
            {repos.map((r) => (
              <div key={r.id} style={{ borderBottom: "1px solid var(--hair)" }}>
                {editingId === r.id ? (
                  <RepoEditRow
                    orgId={orgId}
                    repo={r}
                    onClose={() => setEditingId(null)}
                    onError={(text) => setFlash({ tone: "red", text })}
                  />
                ) : (
                  <RepoRow
                    repo={r}
                    canManage={canManage}
                    revalidating={
                      revalidate.isPending && revalidate.variables === r.id
                    }
                    reonboarding={
                      reonboard.isPending && reonboard.variables === r.id
                    }
                    onRevalidate={() => onRevalidate(r.id)}
                    onReonboard={() => onReonboard(r)}
                    onEdit={() => setEditingId(r.id)}
                    onDisconnect={() => setDisconnectTarget(r)}
                  />
                )}
              </div>
            ))}
          </div>

          <p className="mt-3.5 text-[11.5px] leading-relaxed text-faint">
            {isMember
              ? "Contact an owner to connect or change repos."
              : "Disconnecting a repo permanently deletes its jobs and all their work."}
          </p>
        </>
      )}

      {disconnectTarget ? (
        <DisconnectDialog
          orgId={orgId}
          orgName={orgName}
          repo={disconnectTarget}
          onClose={() => setDisconnectTarget(null)}
        />
      ) : null}
    </>
  );
}

// ── Flash ──────────────────────────────────────────────────────────────────────────────────────
function Flasher({ flash }: { flash: Flash | null }) {
  if (!flash) return null;
  const ok = flash.tone === "green";
  return (
    <div
      className="mb-4 flex items-center gap-2.5 rounded-md px-3.5 py-2.5"
      style={{
        background: ok ? "var(--green-soft)" : RED_SOFT,
        border: `1px solid ${ok ? GREEN_BORDER : RED_BORDER}`,
      }}
    >
      {ok ? (
        <Check size={15} strokeWidth={2.2} style={{ color: "var(--green)" }} />
      ) : (
        <AlertCircle
          size={15}
          strokeWidth={2}
          style={{ color: "var(--red)" }}
        />
      )}
      <span
        className="text-[12.5px] font-medium"
        style={{ color: ok ? "var(--green)" : "var(--red)" }}
      >
        {flash.text}
      </span>
    </div>
  );
}

// ── Loading / Error / Empty states ───────────────────────────────────────────────────────────────
function LoadingState() {
  const widths = [
    ["120px", "210px"],
    ["95px", "185px"],
    ["80px", "160px"],
  ];
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <div
          className="flex items-center px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint"
          style={{
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span className="flex-1">Repository</span>
          <span>Status</span>
        </div>
        <div className="flex flex-col gap-[18px] p-4">
          {widths.map(([w1, w2], i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex flex-col gap-[7px]">
                <Sk w={w1} h="13px" />
                <Sk w={w2} h="10px" />
              </div>
              <Sk w="92px" h="22px" radius="999px" />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-[12px] text-faint">
        <Spinner className="h-[11px] w-[11px] text-accent" />
        Loading repos…
      </div>
    </>
  );
}

function Sk({
  w,
  h,
  radius = "5px",
}: {
  w: string;
  h: string;
  radius?: string;
}) {
  return (
    <span
      className="block animate-pulse"
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        background: "var(--surface-2)",
      }}
    />
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg p-[22px]"
      style={{
        background: RED_SOFT,
        border: `1px solid color-mix(in srgb, var(--red) 30%, transparent)`,
      }}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-surface"
        style={{
          border: `1px solid color-mix(in srgb, var(--red) 38%, transparent)`,
          color: "var(--red)",
        }}
      >
        <AlertCircle size={17} />
      </span>
      <div className="flex-1">
        <div
          className="text-[13.5px] font-semibold"
          style={{ color: "var(--red)" }}
        >
          Couldn’t load repositories.
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-dim">
          The server didn’t respond. Check your connection and try again.
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-md border border-border-2 bg-surface px-3.5 py-2 text-[12px] font-semibold text-text transition hover:bg-surface-2"
      >
        Retry
      </button>
    </div>
  );
}

function EmptyCard({ withToken }: { withToken: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-lg border border-dashed border-border-2 bg-surface-2 px-7 text-center",
        withToken ? "mb-[18px] py-[38px]" : "py-10",
      )}
    >
      <span
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-[13px] border border-border-2 bg-surface"
        style={
          withToken
            ? {
                color: "var(--accent)",
                boxShadow: "0 4px 14px var(--accent-soft)",
              }
            : { color: "var(--faint)" }
        }
      >
        <GitBranch size={22} strokeWidth={1.6} />
      </span>
      <div className="font-disp text-[16px] font-semibold text-text">
        No repositories connected yet
      </div>
      <div className="mt-1.5 max-w-[340px] text-[12.5px] leading-relaxed text-dim">
        {withToken
          ? "Connect a GitHub repo to start running jobs on it."
          : `Connecting a repo needs a GitHub token for this org. Set one in Credentials first.`}
      </div>
    </div>
  );
}

function NoTokenState({
  onOpenCredentials,
}: {
  onOpenCredentials: () => void;
}) {
  return (
    <>
      <EmptyCard withToken={false} />
      <div
        className="mt-[18px] flex items-center gap-3 rounded-lg px-4 py-3.5"
        style={{
          background: "var(--accent-soft)",
          border: "1px solid var(--accent-line)",
        }}
      >
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-surface"
          style={{
            border: "1px solid var(--accent-line)",
            color: "var(--accent)",
          }}
        >
          <Lock size={16} />
        </span>
        <div className="flex-1">
          <div className="text-[12.5px] font-semibold text-text">
            A GitHub token is required
          </div>
          <div className="mt-0.5 text-[11.5px] text-dim">
            Set a GitHub token in Credentials to connect repos.
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenCredentials}
          className="shrink-0 rounded-md px-3.5 py-2 text-[12px] font-semibold text-white transition hover:brightness-105"
          style={{ background: "var(--accent)" }}
        >
          Open Credentials
        </button>
      </div>
      {/* Disabled connect form — a preview of what unlocks once a token is set. */}
      <div
        className="mt-[18px] rounded-lg border border-border bg-surface p-[18px]"
        style={{ opacity: 0.55, pointerEvents: "none" }}
      >
        <div className="mb-3 text-[12.5px] font-semibold text-text">
          Connect a repository
        </div>
        <label className="mb-2 block text-[12px] font-medium text-dim">
          Repo URL
        </label>
        <div className="rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] text-faint">
          https://github.com/owner/repo
        </div>
        <div className="mt-3.5">
          <span
            className="rounded-md px-4 py-2.5 text-[12px] font-semibold text-white"
            style={{ background: "var(--accent)" }}
          >
            Connect
          </span>
        </div>
      </div>
    </>
  );
}

// ── Connect form ─────────────────────────────────────────────────────────────────────────────────
function ConnectForm({
  orgId,
  cancelable,
  onConnected,
  onCancel,
}: {
  orgId: string;
  cancelable: boolean;
  onConnected: (flash: Flash) => void;
  onCancel: () => void;
}) {
  const connect = useConnectRepo(orgId);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");
  const validating = connect.isPending;

  async function submit() {
    if (validating) return;
    const raw = url.trim();
    if (!raw) {
      setError("Enter a repository URL.");
      return;
    }
    if (!GITHUB_URL.test(raw)) {
      setError(
        "Not an HTTPS GitHub URL — expected https://github.com/owner/repo",
      );
      return;
    }
    setError("");
    try {
      const repo = await connect.mutateAsync({
        repoUrl: raw,
        ...(name.trim() ? { displayName: name.trim() } : {}),
        ...(branch.trim() ? { baseBranch: branch.trim() } : {}),
      });
      onConnected({
        tone: repo.accessOk ? "green" : "red",
        text: repo.accessOk
          ? `Connected ${repo.name} — added below.`
          : `Saved ${repo.name}, but access failed. Re-validate it below.`,
      });
      setUrl("");
      setName("");
      setBranch("");
    } catch (e) {
      setError((e as Error)?.message || "Could not connect the repository.");
    }
  }

  return (
    <div
      className="mb-[18px] rounded-lg border bg-surface p-[18px]"
      style={{
        borderColor: "var(--accent-line)",
        boxShadow: "0 6px 22px var(--accent-soft)",
      }}
    >
      <div className="mb-3.5 flex items-center gap-2.5">
        <span
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]"
          style={{
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-line)",
            color: "var(--accent)",
          }}
        >
          <GitBranch size={14} />
        </span>
        <div className="flex-1 text-[13.5px] font-semibold text-text">
          Connect a repository
        </div>
        {validating ? (
          <span
            className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[9px]"
            style={{
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-line)",
              color: "var(--accent)",
            }}
          >
            <Spinner className="h-1.5 w-1.5 text-accent" />
            probing GitHub…
          </span>
        ) : null}
      </div>

      <label className="mb-2 block text-[12px] font-medium text-dim">
        Repo URL <span style={{ color: "var(--accent)" }}>*</span>
      </label>
      <input
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setError("");
        }}
        placeholder="https://github.com/owner/repo"
        className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] text-text outline-none transition placeholder:text-faint focus:border-accent"
      />

      <div className="mt-3 flex gap-3">
        <div className="flex-1">
          <label className="mb-2 block text-[12px] font-medium text-dim">
            Display name{" "}
            <span className="font-normal text-faint">· optional</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Atlas Web"
            className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 text-[13px] text-text outline-none transition placeholder:text-faint focus:border-accent"
          />
        </div>
        <div className="w-40">
          <label className="mb-2 block text-[12px] font-medium text-dim">
            Base branch
          </label>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] text-text outline-none transition placeholder:text-faint focus:border-accent"
          />
        </div>
      </div>

      {error ? (
        <div
          className="mt-2.5 flex items-center gap-1.5 text-[11.5px]"
          style={{ color: "var(--red)" }}
        >
          <AlertCircle size={13} />
          {error}
        </div>
      ) : null}

      <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
        Uses the org GitHub token. A repo your token can’t reach is still saved
        — you can re-validate it later.
      </p>

      <div className="mt-3.5 flex gap-2.5">
        <button
          type="button"
          onClick={submit}
          disabled={validating}
          className="flex items-center gap-1.5 rounded-md px-4 py-2.5 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-75"
          style={{ background: "var(--accent)" }}
        >
          {validating ? <Spinner className="h-[11px] w-[11px]" /> : null}
          {validating ? "Connecting…" : "Connect"}
        </button>
        {cancelable ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border-2 px-3.5 py-2.5 text-[12px] font-medium text-dim transition hover:bg-surface-2"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Repo row (display) ───────────────────────────────────────────────────────────────────────────
function RepoRow({
  repo,
  canManage,
  revalidating,
  reonboarding,
  onRevalidate,
  onReonboard,
  onEdit,
  onDisconnect,
}: {
  repo: RepoView;
  canManage: boolean;
  revalidating: boolean;
  reonboarding: boolean;
  onRevalidate: () => void;
  onReonboard: () => void;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  const threadCount = repo.threadCount ?? 0;
  const hasThreads = threadCount > 0;
  const checked = timeAgo(repo.accessCheckedAt);

  const pill = revalidating
    ? {
        text: "Re-validating…",
        color: "var(--accent)",
        bg: "var(--accent-soft)",
        border: "var(--accent-line)",
      }
    : repo.accessOk
      ? {
          text: "Connected",
          color: "var(--green)",
          bg: "var(--green-soft)",
          border: GREEN_BORDER,
        }
      : {
          text: "Access failed",
          color: "var(--red)",
          bg: RED_SOFT,
          border: RED_BORDER,
        };

  return (
    <div className="flex flex-wrap items-start gap-4 px-4 py-[15px]">
      {/* identity */}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-text">{repo.name}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
          {repo.gitUrl}
        </div>
        <div className="mt-2 flex items-center gap-2.5">
          <span
            className="flex items-center gap-1.5 rounded-sm border border-border-2 px-2 py-[3px] font-mono text-[10px] text-dim"
            style={{ background: "var(--surface-3)" }}
          >
            <GitBranch size={11} />
            {repo.defaultBranch}
          </span>
          <span
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: hasThreads ? "var(--dim)" : "var(--faint)" }}
          >
            <MessageSquare size={12} />
            {hasThreads
              ? `${threadCount} job${threadCount === 1 ? "" : "s"}`
              : "No jobs"}
          </span>
        </div>
      </div>

      {/* right: pill + actions */}
      <div className="flex w-full flex-col items-end gap-2.5 sm:w-auto sm:shrink-0">
        <span
          className="flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-medium"
          style={{
            color: pill.color,
            background: pill.bg,
            border: `1px solid ${pill.border}`,
          }}
        >
          {revalidating ? (
            <Spinner className="h-1.5 w-1.5 text-accent" />
          ) : (
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: pill.color }}
            />
          )}
          {pill.text}
        </span>

        {!revalidating && checked ? (
          <span className="font-mono text-[9.5px] text-faint">
            checked {checked}
          </span>
        ) : null}

        {!revalidating && !repo.accessOk ? (
          <span
            className="max-w-[200px] text-right text-[10.5px] leading-snug"
            style={{ color: "var(--red)" }}
          >
            repo unreachable or token lacks access
          </span>
        ) : null}

        {!revalidating && repo.accessOk && repo.webhookWarning ? (
          <span
            className="flex max-w-[220px] items-start gap-1.5 text-right text-[10.5px] leading-snug"
            style={{ color: "var(--amber)" }}
            title={repo.webhookWarning}
          >
            <AlertCircle size={12} className="mt-px shrink-0" />
            <span>real-time PR sync off — {repo.webhookWarning}</span>
          </span>
        ) : null}

        {canManage ? (
          <>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {repo.accessOk ? (
                <button
                  type="button"
                  onClick={onReonboard}
                  disabled={reonboarding}
                  title={
                    repo.onboardedAt
                      ? "Re-run Atlas onboarding — re-derive this repo’s setup (env files, build commands, cache)"
                      : "Onboard this repo with Atlas — it learns how to build/run the repo and records the setup"
                  }
                  className="flex items-center gap-1.5 rounded-sm border px-2.5 py-[5px] text-[11px] font-semibold text-accent transition hover:bg-surface-2 disabled:opacity-60"
                  style={{ borderColor: "var(--accent-line)" }}
                >
                  {reonboarding ? (
                    <Spinner className="h-3 w-3 text-accent" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  {repo.onboardedAt ? "Re-run setup" : "Set up with Atlas"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onRevalidate}
                className="flex items-center gap-1.5 rounded-sm border px-2.5 py-[5px] text-[11px] font-semibold transition hover:bg-surface-2"
                style={{
                  color: repo.accessOk ? "var(--dim)" : "var(--accent)",
                  borderColor: repo.accessOk
                    ? "var(--border-2)"
                    : "var(--accent-line)",
                }}
              >
                <RefreshCw size={12} />
                Re-validate
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="rounded-sm border border-border-2 px-2.5 py-[5px] text-[11px] font-semibold text-dim transition hover:bg-surface-2"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onDisconnect}
                title={
                  hasThreads
                    ? `Disconnect — deletes ${threadCount} job${threadCount === 1 ? "" : "s"}`
                    : "Disconnect this repo"
                }
                className="rounded-sm border border-border-2 px-2.5 py-[5px] text-[11px] font-semibold text-dim transition hover:bg-surface-2 hover:text-red"
              >
                Disconnect
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Repo row (edit metadata) ─────────────────────────────────────────────────────────────────────
function RepoEditRow({
  orgId,
  repo,
  onClose,
  onError,
}: {
  orgId: string;
  repo: RepoView;
  onClose: () => void;
  onError: (text: string) => void;
}) {
  const update = useUpdateRepo(orgId);
  const [name, setName] = useState(repo.name);
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [branchPrefix, setBranchPrefix] = useState(repo.branchPrefix ?? "");
  const [mergeMethod, setMergeMethod] = useState<AutoMergeMethod>(
    repo.defaultAutoMergeMethod,
  );
  const [deleteBranch, setDeleteBranch] = useState(
    repo.defaultAutoMergeDeleteBranch,
  );

  async function save() {
    if (update.isPending) return;
    try {
      await update.mutateAsync({
        repoId: repo.id,
        body: {
          name: name.trim() || repo.name,
          defaultBranch: branch.trim() || repo.defaultBranch,
          // Empty clears the override back to the neutral default.
          branchPrefix: branchPrefix.trim(),
          defaultAutoMergeMethod: mergeMethod,
          defaultAutoMergeDeleteBranch: deleteBranch,
        },
      });
      onClose();
    } catch (e) {
      onError((e as Error)?.message || "Could not save changes.");
    }
  }

  return (
    <div className="px-4 py-[15px]" style={{ background: "var(--surface-2)" }}>
      <div className="mb-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
        Edit metadata · {repo.gitUrl}
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="mb-1.5 block text-[11.5px] font-medium text-dim">
            Display name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none transition focus:border-accent"
          />
        </div>
        <div className="w-48">
          <label className="mb-1.5 block text-[11.5px] font-medium text-dim">
            Base branch
          </label>
          <BranchPicker
            orgId={orgId}
            repoId={repo.id}
            value={branch}
            onChange={setBranch}
            fallback={repo.defaultBranch}
          />
        </div>
        <div className="w-48">
          <label className="mb-1.5 block text-[11.5px] font-medium text-dim">
            Branch prefix
          </label>
          <input
            value={branchPrefix}
            onChange={(e) => setBranchPrefix(e.target.value)}
            placeholder="feature/"
            className="w-full rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none transition focus:border-accent"
          />
        </div>
      </div>

      <div className="mt-3.5 flex flex-col gap-3 border-t border-dashed border-border-2 pt-3.5">
        <div className="w-48">
          <label
            htmlFor="repo-edit-merge-method"
            className="mb-1.5 block text-[11.5px] font-medium text-dim"
          >
            Merge method
          </label>
          <select
            id="repo-edit-merge-method"
            data-testid="repo-edit-merge-method"
            value={mergeMethod}
            onChange={(e) => setMergeMethod(e.target.value as AutoMergeMethod)}
            className="w-full rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] capitalize text-text outline-none transition focus:border-accent"
          >
            {AUTO_MERGE_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-2.5">
          <div>
            <label
              htmlFor="repo-edit-delete-branch"
              className="mb-0.5 block text-[11.5px] font-medium text-dim"
            >
              Delete branch after merge
            </label>
            <p className="text-[10.5px] leading-snug text-faint">
              Removes the head branch once Atlas merges the PR.
            </p>
          </div>
          <button
            id="repo-edit-delete-branch"
            type="button"
            role="switch"
            aria-checked={deleteBranch}
            aria-label="Delete branch after merge"
            data-testid="repo-edit-delete-branch"
            onClick={() => setDeleteBranch((v) => !v)}
            className="relative h-[17px] w-[30px] shrink-0 rounded-full border transition-colors"
            style={{
              background: deleteBranch ? "var(--green)" : "var(--surface-3)",
              borderColor: deleteBranch ? "var(--green)" : "var(--border-2)",
            }}
          >
            <span
              className="absolute top-[1px] left-[1px] h-[13px] w-[13px] rounded-full bg-white transition-transform"
              style={{
                transform: deleteBranch ? "translateX(13px)" : "translateX(0)",
                boxShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
              }}
            />
          </button>
        </div>
      </div>

      <div className="mt-3 flex gap-2.5">
        <button
          type="button"
          onClick={save}
          disabled={update.isPending}
          className="flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-75"
          style={{ background: "var(--accent)" }}
        >
          {update.isPending ? <Spinner className="h-[11px] w-[11px]" /> : null}
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border-2 px-3.5 py-2 text-[12px] font-medium text-dim transition hover:bg-surface-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Disconnect confirm ───────────────────────────────────────────────────────────────────────────
function DisconnectDialog({
  orgId,
  orgName,
  repo,
  onClose,
}: {
  orgId: string;
  orgName: string;
  repo: RepoView;
  onClose: () => void;
}) {
  const disconnect = useDisconnectRepo(orgId);
  const [error, setError] = useState("");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const threadCount = repo.threadCount ?? 0;
  const hasThreads = threadCount > 0;
  const threadLabel = `${threadCount} job${threadCount === 1 ? "" : "s"}`;

  // Esc to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function confirm() {
    if (disconnect.isPending) return;
    try {
      await disconnect.mutateAsync(repo.id);
      onClose();
    } catch (e) {
      setError((e as Error)?.message || "Could not disconnect the repository.");
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[70] flex justify-center"
      style={{
        background: "rgba(10,12,16,.5)",
        backdropFilter: "blur(3px)",
        paddingTop: 130,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="h-fit w-[430px] max-w-[90%] overflow-hidden rounded-lg border border-border-2 bg-panel"
        style={{ boxShadow: "var(--shadow-palette)" }}
      >
        <div className="px-5 pb-[18px] pt-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]"
              style={{
                background: RED_SOFT,
                border: `1px solid ${RED_BORDER}`,
                color: "var(--red)",
              }}
            >
              <Power size={17} />
            </span>
            <div className="font-disp text-[16px] font-semibold text-text">
              Disconnect {repo.name}?
            </div>
          </div>
          {hasThreads ? (
            <div
              className="text-[12.5px] leading-relaxed"
              style={{ color: "var(--red)" }}
            >
              This permanently deletes <strong>{threadLabel}</strong> and all
              their work — feature branches, sandboxes, messages, and history.
              This can’t be undone.
            </div>
          ) : (
            <div className="text-[12.5px] leading-relaxed text-dim">
              This removes it from {orgName}. No jobs are affected — there are
              none.
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 font-mono text-[11px] text-dim">
            <GitBranch size={13} />
            <span className="truncate">{repo.gitUrl}</span>
          </div>
          {error ? (
            <div
              className="mt-3 flex items-center gap-1.5 text-[11.5px]"
              style={{ color: "var(--red)" }}
            >
              <AlertCircle size={13} />
              {error}
            </div>
          ) : null}
        </div>
        <div
          className="flex items-center gap-2.5 px-5 py-3.5"
          style={{
            borderTop: "1px solid var(--border)",
            background: "var(--surface-2)",
          }}
        >
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-2 px-3.5 py-2.5 text-[12.5px] font-medium text-dim transition hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={disconnect.isPending}
            className="flex items-center gap-1.5 rounded-md px-4 py-2.5 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:opacity-75"
            style={{ background: "var(--red)" }}
          >
            {disconnect.isPending ? (
              <Spinner className="h-[11px] w-[11px]" />
            ) : null}
            {hasThreads ? `Delete ${threadLabel} & disconnect` : "Disconnect"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
function timeAgo(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
