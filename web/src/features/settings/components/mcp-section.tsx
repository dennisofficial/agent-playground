"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  KeyRound,
  LayoutGrid,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  Repeat,
  Share2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useOrg } from "@/lib/api/me";
import {
  useDeleteMcpServer,
  useMcpOAuthConnect,
  useMcpServers,
  useSaveMcpServer,
  useValidateMcpServer,
  type McpAuthKind,
  type McpServer,
  type McpSurface,
  type McpTransport,
  type McpValidateResult,
  type SaveMcpServerBody,
  type StoredMcpConfig,
  type SystemMcpServer,
} from "@/lib/api/orgs";
import { useOrgRepos } from "@/lib/api/job-queries";

/**
 * MCP servers — extra tool servers the agent can call, resolved in three layers:
 *  - **System** — built-in (TypeScript LSP, Context7). Read-only; shown so operators know what's on.
 *  - **Organization** — user servers shared across every repo and job.
 *  - **Repository** — user servers scoped to one repo; they override an org server of the same name.
 *
 * Secret header/env values are never returned (they come back redacted as `null` slots, surfaced via
 * `secretKeys`). A secret field is write-only: it renders masked, and re-entering a value changes it —
 * leaving a stored secret untouched preserves it. Owner-only writes (the server enforces it).
 */
export function McpSection({ orgId, role }: { orgId: string; role: string }) {
  const { data, isLoading, isError, refetch } = useMcpServers(orgId);
  const org = useOrg(orgId);
  const isOwner = role === "owner";

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
        MCP Servers
      </h1>
      <p className="mb-4 mt-1.5 max-w-[640px] text-[13px] leading-relaxed text-dim">
        Tool servers the agent can call. They resolve in three layers:{" "}
        <b className="font-semibold text-text">System</b> servers are built in
        and always on; <b className="font-semibold text-text">Organization</b>{" "}
        servers are shared across every repo &amp; job;{" "}
        <b className="font-semibold text-text">Repository</b> servers add to a
        single repo and override an org server of the same name.
      </p>

      {!isOwner ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[11.5px] text-faint">
          <Lock size={13} />
          Read-only — only owners can add, edit, validate, or delete MCP
          servers.
        </div>
      ) : null}

      {isLoading ? (
        <div className="mt-7 flex items-center gap-2 text-[12px] text-faint">
          <Spinner className="h-3 w-3" /> Loading MCP servers…
        </div>
      ) : isError || !data ? (
        <div className="mt-7 flex items-start gap-3 rounded-lg border border-red-line bg-red-soft p-5">
          <AlertCircle size={17} className="mt-0.5 shrink-0 text-red" />
          <div className="flex-1">
            <div className="text-[13.5px] font-semibold text-red">
              Couldn’t load MCP servers.
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
      ) : (
        <>
          <SystemTier system={data.system} />

          <div className="h-[34px]" />

          <McpTier
            orgId={orgId}
            scope="org"
            title="Organization MCPs"
            count={data.servers.filter((s) => s.scope === "org").length}
            description={`Available to every repo and job${org?.name ? ` in ${org.name}` : ""}.`}
            servers={data.servers.filter((s) => s.scope === "org")}
            orgServers={data.servers.filter((s) => s.scope === "org")}
            canManage={isOwner}
            emptyIcon={<LayoutGrid size={20} />}
            emptyTitle="No MCP servers yet"
            emptyBody="Add an org-wide server (like Linear or Sentry) to give every thread access to its tools."
          />

          <div className="h-[34px]" />

          <RepoTier
            orgId={orgId}
            allServers={data.servers}
            canManage={isOwner}
          />
        </>
      )}
    </>
  );
}

// ── Tier 1 · System (read-only) ───────────────────────────────────────────────────────────────────
function SystemTier({ system }: { system: SystemMcpServer[] }) {
  return (
    <>
      <div className="mb-3 flex items-center gap-2.5">
        <div className="font-disp text-[15px] font-semibold text-text">
          System
        </div>
        <span
          className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[9px] text-green"
          style={{
            background: "var(--green-soft)",
            borderColor: "color-mix(in srgb, var(--green) 30%, transparent)",
          }}
        >
          <span className="h-[5px] w-[5px] rounded-full bg-green" />
          always on
        </span>
        <div className="h-px flex-1 bg-border" />
        <span className="font-mono text-[9px] text-faint">read-only</span>
      </div>

      <div className="flex flex-col gap-2.5">
        {system.map((s) => (
          <div
            key={s.name}
            className="rounded-lg border border-border bg-surface-2 px-4 py-3.5"
            style={{ opacity: s.active ? 1 : 0.72 }}
          >
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[13px] font-semibold text-text">
                {s.name}
              </span>
              <TransportBadge transport={s.transport} />
              <div className="flex-1" />
              {s.active ? (
                <span
                  className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-medium text-green"
                  style={{
                    background: "var(--green-soft)",
                    borderColor:
                      "color-mix(in srgb, var(--green) 30%, transparent)",
                  }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-green" />
                  active
                </span>
              ) : (
                <span
                  title={s.inactiveReason}
                  className="flex items-center gap-1.5 rounded-full border border-border-2 bg-surface px-2.5 py-0.5 text-[10px] font-medium text-faint"
                >
                  <span className="h-1.5 w-1.5 rounded-full border border-faint" />
                  inactive
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[12px] leading-relaxed text-dim">
              {s.description}
            </div>
            {!s.active && s.inactiveReason ? (
              <div className="mt-1.5 text-[11px] text-faint">
                {s.inactiveReason}
              </div>
            ) : null}
            {s.tools.length > 0 ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 font-mono text-[9px] tracking-[0.08em] text-faint">
                  TOOLS
                </span>
                {s.tools.map((t) => (
                  <span
                    key={t}
                    className="rounded-sm border border-border-2 bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-dim"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Tier 3 · Repository (a repo picker scoping a tier) ─────────────────────────────────────────────
function RepoTier({
  orgId,
  allServers,
  canManage,
}: {
  orgId: string;
  allServers: McpServer[];
  canManage: boolean;
}) {
  const { data: repos } = useOrgRepos(orgId);
  const [repoId, setRepoId] = useState("");
  const repo = repos?.find((r) => r.id === repoId);
  const repoServers = useMemo(
    () => allServers.filter((s) => s.scope === repoId),
    [allServers, repoId],
  );
  const orgServers = useMemo(
    () => allServers.filter((s) => s.scope === "org"),
    [allServers],
  );

  return (
    <>
      <div className="mb-1.5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <div className="font-disp text-[15px] font-semibold text-text">
              Repository MCPs
            </div>
            <CountPill n={repoServers.length} />
          </div>
          <div className="mt-1 text-[12px] text-dim">
            Scoped to one repo. Overrides an org server of the same name.
          </div>
        </div>
      </div>

      <div className="my-3.5 flex items-center gap-2.5">
        <span className="font-mono text-[9px] tracking-[0.1em] text-faint">
          REPO
        </span>
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
        {repo?.gitUrl ? (
          <span className="truncate text-[11.5px] text-faint">
            {repo.gitUrl}
          </span>
        ) : null}
      </div>

      {!repoId ? (
        <p className="text-[12px] text-faint">
          Pick a repo to manage servers scoped to it.
        </p>
      ) : (
        <McpTier
          key={repoId}
          orgId={orgId}
          scope={repoId}
          hideHeader
          title="Repository MCPs"
          count={repoServers.length}
          description=""
          servers={repoServers}
          orgServers={orgServers}
          canManage={canManage}
          emptyIcon={<Share2 size={20} />}
          emptyTitle={`No MCP servers for ${repo?.name ?? "this repo"}`}
          emptyBody="This repo uses only system and org servers. Add a repo-scoped server to give just this repo extra tools."
        />
      )}
    </>
  );
}

// ── A tier body: header + add button + empty/form/list + delete modal ─────────────────────────────
function McpTier({
  orgId,
  scope,
  title,
  count,
  description,
  servers,
  orgServers,
  canManage,
  emptyIcon,
  emptyTitle,
  emptyBody,
  hideHeader = false,
}: {
  orgId: string;
  scope: string;
  title: string;
  count: number;
  description: string;
  servers: McpServer[];
  orgServers: McpServer[];
  canManage: boolean;
  emptyIcon: React.ReactNode;
  emptyTitle: string;
  emptyBody: string;
  hideHeader?: boolean;
}) {
  const [form, setForm] = useState<{ server: McpServer | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const orgNames = useMemo(
    () => new Set(orgServers.map((s) => s.name)),
    [orgServers],
  );

  const addBtn =
    canManage && !form ? (
      <button
        type="button"
        onClick={() => setForm({ server: null })}
        className="flex shrink-0 items-center gap-1.5 rounded-md px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105"
        style={{
          background: "var(--accent)",
          boxShadow: "0 4px 14px var(--accent-soft)",
        }}
      >
        <Plus size={14} /> Add server
      </button>
    ) : null;

  return (
    <>
      {!hideHeader ? (
        <div className="mb-3.5 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <div className="font-disp text-[15px] font-semibold text-text">
                {title}
              </div>
              <CountPill n={count} />
            </div>
            {description ? (
              <div className="mt-1 text-[12px] text-dim">{description}</div>
            ) : null}
          </div>
          {addBtn}
        </div>
      ) : (
        <div className="mb-3.5 flex justify-end">{addBtn}</div>
      )}

      {form ? (
        <ServerForm
          orgId={orgId}
          scope={scope}
          existing={form.server}
          existingNames={servers.map((s) => s.name)}
          onClose={() => setForm(null)}
        />
      ) : null}

      {servers.length === 0 && !form ? (
        <EmptyState
          icon={emptyIcon}
          title={emptyTitle}
          body={emptyBody}
          onAdd={canManage ? () => setForm({ server: null }) : undefined}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {servers.map((s) => (
            <ServerRow
              key={s.name}
              orgId={orgId}
              scope={scope}
              server={s}
              isOverride={scope !== "org" && orgNames.has(s.name)}
              canManage={canManage}
              onEdit={() => setForm({ server: s })}
              onDelete={() => setDeleteTarget(s)}
            />
          ))}
        </div>
      )}

      {deleteTarget ? (
        <DeleteModal
          orgId={orgId}
          scope={scope}
          server={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </>
  );
}

function CountPill({ n }: { n: number }) {
  return (
    <span className="rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-dim">
      {n}
    </span>
  );
}

function EmptyState({
  icon,
  title,
  body,
  onAdd,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onAdd?: () => void;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border-2 bg-surface-2 px-7 py-8 text-center">
      <div className="mb-3.5 flex h-11 w-11 items-center justify-center rounded-xl border border-border-2 bg-surface text-faint">
        {icon}
      </div>
      <div className="font-disp text-[15px] font-semibold text-text">
        {title}
      </div>
      <div className="mt-1.5 max-w-[360px] text-[12.5px] leading-relaxed text-dim">
        {body}
      </div>
      {onAdd ? (
        <button
          type="button"
          onClick={onAdd}
          className="mt-4 flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105"
          style={{
            background: "var(--accent)",
            boxShadow: "0 4px 14px var(--accent-soft)",
          }}
        >
          <Plus size={14} /> Add server
        </button>
      ) : null}
    </div>
  );
}

// ── A configured-server row ───────────────────────────────────────────────────────────────────────
function ServerRow({
  orgId,
  scope,
  server,
  isOverride,
  canManage,
  onEdit,
  onDelete,
}: {
  orgId: string;
  scope: string;
  server: McpServer;
  isOverride: boolean;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const validate = useValidateMcpServer(orgId);
  const target = endpointLabel(server.config, server.transport);
  const v = validationState(server, validate.isPending, validate.data);

  return (
    <div
      className="rounded-lg border border-border bg-surface px-4 py-3.5"
      style={{ opacity: server.enabled ? 1 : 0.62 }}
    >
      <div className="flex items-start gap-3.5">
        {/* left: identity */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-semibold text-text">
              {server.name}
            </span>
            <TransportBadge transport={server.transport} />
            {server.authKind === "oauth" ? <OAuthBadge server={server} /> : null}
            {isOverride ? (
              <span
                className="flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] text-accent"
                style={{
                  background: "var(--accent-soft)",
                  borderColor: "var(--accent-line)",
                }}
              >
                <Repeat size={10} /> overrides org
              </span>
            ) : null}
            {!server.enabled ? (
              <span className="rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-faint">
                disabled
              </span>
            ) : null}
          </div>

          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-faint">
            {server.transport === "stdio" ? (
              <Terminal size={11} className="shrink-0" />
            ) : (
              <Link2 size={11} className="shrink-0" />
            )}
            <span className="truncate">{target}</span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[8.5px] tracking-[0.08em] text-faint">
              APPLIES TO
            </span>
            {server.surfaces.map((s) => (
              <span
                key={s}
                className="rounded-sm border border-border-2 bg-surface-3 px-1.5 py-0.5 font-mono text-[9.5px] text-dim"
              >
                {surfaceLabel(s)}
              </span>
            ))}
          </div>
        </div>

        {/* right: validation + actions */}
        <div className="flex shrink-0 flex-col items-end gap-2.5">
          <span
            title={v.title}
            className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium"
            style={{ color: v.color, background: v.bg, borderColor: v.border }}
          >
            {v.spin ? (
              <Spinner className="h-2.5 w-2.5" />
            ) : (
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: v.color }}
              />
            )}
            {v.text}
          </span>

          {canManage ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  validate.mutate({ scope, name: server.name })
                }
                disabled={validate.isPending}
                className="flex items-center gap-1.5 rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-2 disabled:opacity-60"
              >
                <RefreshCw size={12} /> Validate
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-2"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:text-red"
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Delete confirm modal ──────────────────────────────────────────────────────────────────────────
function DeleteModal({
  orgId,
  scope,
  server,
  onClose,
}: {
  orgId: string;
  scope: string;
  server: McpServer;
  onClose: () => void;
}) {
  const del = useDeleteMcpServer(orgId);
  const scopeLabel = scope === "org" ? "this organization" : "this repo";

  async function confirm() {
    try {
      await del.mutateAsync({ scope, name: server.name });
      onClose();
    } catch {
      onClose();
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[150px]"
      style={{ background: "rgba(10,12,16,.5)", backdropFilter: "blur(3px)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[430px] max-w-[90%] overflow-hidden rounded-lg border border-border-2 bg-panel"
        style={{ boxShadow: "0 30px 80px rgba(0,0,0,.4)" }}
      >
        <div className="p-5 pb-4">
          <div className="mb-3 flex items-center gap-3">
            <div
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg text-red"
              style={{
                background: "var(--red-soft)",
                border:
                  "1px solid color-mix(in srgb, var(--red) 40%, transparent)",
              }}
            >
              <Trash2 size={17} />
            </div>
            <div className="font-disp text-[16px] font-semibold text-text">
              Delete {server.name}?
            </div>
          </div>
          <div className="text-[12.5px] leading-relaxed text-dim">
            Removes this MCP server from {scopeLabel}. Agent sessions will no
            longer see its tools. This can’t be undone.
          </div>
          <div className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-dim">
            mcp__{server.name}__*
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-2 px-3.5 py-2 text-[12.5px] font-medium text-dim transition hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={del.isPending}
            className="flex items-center gap-2 rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
            style={{ background: "var(--red)" }}
          >
            {del.isPending ? <Spinner className="h-3 w-3" /> : null}
            Delete server
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The add / edit form ───────────────────────────────────────────────────────────────────────────
interface PairRow {
  k: string;
  v: string;
  secret: boolean;
  /** Came from the server as a stored secret (value withheld). */
  stored: boolean;
  /** User clicked "Replace" to enter a fresh value for a stored secret. */
  revealed: boolean;
}

const SURFACE_META: { key: McpSurface; label: string; sub: string }[] = [
  { key: "brain", label: "Brain", sub: "operator chat" },
  { key: "build", label: "Build turns", sub: "coding sessions" },
  { key: "review", label: "Review", sub: "review passes" },
];

function ServerForm({
  orgId,
  scope,
  existing,
  existingNames,
  onClose,
}: {
  orgId: string;
  scope: string;
  existing: McpServer | null;
  existingNames: string[];
  onClose: () => void;
}) {
  const save = useSaveMcpServer(orgId);
  const validate = useValidateMcpServer(orgId);

  // Once a new server is committed (via in-form Validate), lock its name like an edit.
  const [committed, setCommitted] = useState(existing !== null);
  const isEdit = existing !== null;
  const nameLocked = isEdit || committed;

  const [name, setName] = useState(existing?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(
    existing?.transport ?? "http",
  );
  const [url, setUrl] = useState(existing?.config.url ?? "");
  const [command, setCommand] = useState(existing?.config.command ?? "");
  const [args, setArgs] = useState<string[]>(existing?.config.args ?? []);
  const [headers, setHeaders] = useState<PairRow[]>(
    configToRows(existing?.config.headers),
  );
  const [env, setEnv] = useState<PairRow[]>(configToRows(existing?.config.env));
  const [surfaces, setSurfaces] = useState<McpSurface[]>(
    existing?.surfaces ?? ["brain", "build"],
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [authKind, setAuthKind] = useState<McpAuthKind>(
    existing?.authKind ?? "static",
  );
  const [oauthScope, setOauthScope] = useState(existing?.config.oauth?.scope ?? "");
  const [nameErr, setNameErr] = useState("");
  const [formErr, setFormErr] = useState("");
  const [valResult, setValResult] = useState<McpValidateResult | null>(null);
  // Live consent state for the OAuth Connect flow (the popup posts back here on completion).
  const { connect: connectOAuth, busy: oauthBusy, result: oauthMsg } = useMcpOAuthConnect(orgId);

  const isRemote = transport === "http" || transport === "sse";
  const isOAuth = isRemote && authKind === "oauth";

  const canSave =
    name.trim().length > 0 &&
    surfaces.length > 0 &&
    (isRemote ? url.trim().length > 0 : command.trim().length > 0);

  function toggleSurface(s: McpSurface) {
    setSurfaces((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );
  }

  /** Validate the form and build the write payload, or set an error and return null. */
  function buildBody(): { name: string; body: SaveMcpServerBody } | null {
    const n = name.trim();
    if (!n) {
      setNameErr("Enter a server name.");
      return null;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(n)) {
      setNameErr("Letters, numbers, dashes and underscores only.");
      return null;
    }
    if (!nameLocked && existingNames.includes(n)) {
      setNameErr("A server with that name already exists at this scope.");
      return null;
    }
    setNameErr("");
    if (surfaces.length === 0) {
      setFormErr("Pick at least one surface it applies to.");
      return null;
    }
    const body: SaveMcpServerBody = { transport, surfaces, enabled };
    if (isRemote) {
      if (!url.trim()) {
        setFormErr("Enter the server URL.");
        return null;
      }
      body.url = url.trim();
      if (authKind === "oauth") {
        body.authKind = "oauth";
        const s = oauthScope.trim();
        if (s) body.oauth = { scope: s };
      } else {
        body.authKind = "static";
        body.headers = rowsToInput(headers);
      }
    } else {
      if (!command.trim()) {
        setFormErr("Enter the command to run.");
        return null;
      }
      body.authKind = "static";
      body.command = command.trim();
      body.args = args.map((a) => a.trim()).filter(Boolean);
      body.env = rowsToInput(env);
    }
    setFormErr("");
    return { name: n, body };
  }

  /** Save the (oauth) server, then open the provider consent popup — the callback finishes the exchange. */
  async function onConnect() {
    const saved = await persist();
    if (!saved) return;
    await connectOAuth({ scope, name: saved });
  }

  async function persist(): Promise<string | null> {
    const built = buildBody();
    if (!built) return null;
    try {
      await save.mutateAsync({ scope, name: built.name, body: built.body });
      setCommitted(true);
      return built.name;
    } catch (e) {
      setFormErr((e as Error)?.message || "Could not save.");
      return null;
    }
  }

  async function onSave() {
    const saved = await persist();
    if (saved) onClose();
  }

  async function onValidate() {
    const saved = await persist();
    if (!saved) return;
    try {
      const res = await validate.mutateAsync({ scope, name: saved });
      setValResult(res);
    } catch (e) {
      setValResult({ ok: false, error: (e as Error)?.message || "Validation failed." });
    }
  }

  return (
    <div
      className="mb-3.5 rounded-lg border p-[18px]"
      style={{
        borderColor: "var(--accent-line)",
        background: "var(--surface)",
        boxShadow: "0 6px 22px var(--accent-soft)",
      }}
    >
      <div className="mb-4 flex items-center gap-2.5">
        <div
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-accent"
          style={{
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-line)",
          }}
        >
          <LayoutGrid size={14} />
        </div>
        <div className="text-[13.5px] font-semibold text-text">
          {isEdit ? `Edit ${existing.name}` : "New MCP server"}
        </div>
      </div>

      {/* Name */}
      <FormLabel>
        Name <span className="text-accent">*</span>
      </FormLabel>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={nameLocked}
        placeholder="linear"
        className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[13px] font-semibold text-text outline-none placeholder:text-faint disabled:opacity-60"
      />
      {nameErr ? (
        <div className="mt-1.5 text-[11px] text-red">{nameErr}</div>
      ) : null}
      <div className="mt-1.5 font-mono text-[10.5px] text-faint">
        Namespaces tools as{" "}
        <span className="text-dim">mcp__{name || "<name>"}__&lt;tool&gt;</span>
      </div>

      {/* Transport */}
      <FormLabel className="mt-4">Transport</FormLabel>
      <div className="flex gap-1 rounded-md border border-border-2 bg-surface-2 p-1">
        {(
          [
            ["http", "HTTP"],
            ["sse", "SSE"],
            ["stdio", "stdio (command)"],
          ] as [McpTransport, string][]
        ).map(([t, label]) => {
          const on = transport === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTransport(t)}
              className="flex-1 rounded-sm py-2 text-center text-[12px] font-semibold transition"
              style={{
                background: on ? "var(--surface)" : "transparent",
                color: on ? "var(--accent)" : "var(--dim)",
                boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : undefined,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Remote: url + auth (static headers | OAuth) */}
      {isRemote ? (
        <>
          <FormLabel className="mt-4">
            {transport === "sse" ? "SSE URL" : "URL"}{" "}
            <span className="text-accent">*</span>
          </FormLabel>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/sse"
            className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[13px] text-text outline-none placeholder:text-faint"
          />

          <FormLabel className="mt-4">Authentication</FormLabel>
          <div className="flex gap-1 rounded-md border border-border-2 bg-surface-2 p-1">
            {(
              [
                ["static", "Static headers"],
                ["oauth", "OAuth"],
              ] as [McpAuthKind, string][]
            ).map(([k, label]) => {
              const on = authKind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setAuthKind(k)}
                  className="flex-1 rounded-sm py-2 text-center text-[12px] font-semibold transition"
                  style={{
                    background: on ? "var(--surface)" : "transparent",
                    color: on ? "var(--accent)" : "var(--dim)",
                    boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : undefined,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {isOAuth ? (
            <OAuthConnect
              isEdit={isEdit}
              existing={existing}
              scope={oauthScope}
              onScopeChange={setOauthScope}
              busy={oauthBusy || save.isPending}
              message={oauthMsg}
              onConnect={onConnect}
            />
          ) : (
            <PairEditor
              label="Headers"
              addLabel="Add header"
              keyPlaceholder="Header-Name"
              rows={headers}
              onChange={setHeaders}
            />
          )}
        </>
      ) : (
        <>
          <FormLabel className="mt-4">
            Command <span className="text-accent">*</span>
          </FormLabel>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx"
            className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[13px] text-text outline-none placeholder:text-faint"
          />
          <ArgsEditor rows={args} onChange={setArgs} />
          <PairEditor
            label="Environment variables"
            addLabel="Add variable"
            keyPlaceholder="ENV_KEY"
            rows={env}
            onChange={setEnv}
          />
        </>
      )}

      {/* Surfaces */}
      <FormLabel className="mt-[18px]">Applies to</FormLabel>
      <div className="flex flex-wrap gap-2">
        {SURFACE_META.map(({ key, label, sub }) => {
          const on = surfaces.includes(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleSurface(key)}
              className="flex min-w-[140px] flex-1 items-center gap-2.5 rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 text-left transition"
            >
              <span
                className="flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border"
                style={{
                  background: on ? "var(--accent)" : "transparent",
                  borderColor: on ? "var(--accent)" : "var(--border-2)",
                }}
              >
                {on ? <Check size={11} strokeWidth={3.2} color="#fff" /> : null}
              </span>
              <span>
                <span className="block text-[12px] font-semibold text-text">
                  {label}
                </span>
                <span className="block text-[10px] text-faint">{sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Enabled */}
      <div className="mt-4 flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => setEnabled((e) => !e)}
          className="relative h-[19px] w-[34px] shrink-0 rounded-full transition-colors"
          style={{ background: enabled ? "var(--accent)" : "var(--border-2)" }}
          aria-pressed={enabled}
        >
          <span
            className="absolute top-0.5 h-[15px] w-[15px] rounded-full bg-white transition-all"
            style={{
              left: enabled ? "17px" : "2px",
              boxShadow: "0 1px 3px rgba(0,0,0,.3)",
            }}
          />
        </button>
        <span className="text-[12.5px] font-semibold text-text">Enabled</span>
        <span className="text-[11px] text-faint">
          Agent sessions can call this server’s tools.
        </span>
      </div>

      {/* In-form validation result */}
      {valResult?.ok ? (
        <div
          className="mt-4 rounded-md border p-3.5"
          style={{
            background: "var(--green-soft)",
            borderColor: "color-mix(in srgb, var(--green) 32%, transparent)",
          }}
        >
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-green">
            <CheckCircle2 size={14} />
            Validated — discovered {valResult.discoveredTools?.length ?? 0} tools
          </div>
          {valResult.discoveredTools &&
          valResult.discoveredTools.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {valResult.discoveredTools.map((t) => (
                <span
                  key={t}
                  className="rounded-sm border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-dim"
                  style={{
                    borderColor:
                      "color-mix(in srgb, var(--green) 25%, transparent)",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : valResult && !valResult.ok ? (
        <div
          className="mt-4 flex items-start gap-2 rounded-md border p-3.5"
          style={{
            background: "var(--red-soft)",
            borderColor: "color-mix(in srgb, var(--red) 35%, transparent)",
          }}
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-red" />
          <div className="text-[12px] leading-relaxed text-red">
            {valResult.error ?? "Validation failed."}
          </div>
        </div>
      ) : null}

      {formErr ? (
        <div className="mt-3 text-[11.5px] text-red">{formErr}</div>
      ) : null}

      {/* Footer */}
      <div className="mt-[18px] flex items-center gap-2.5">
        <button
          type="button"
          onClick={onSave}
          disabled={save.isPending || !canSave}
          className="rounded-md px-4 py-2.5 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {save.isPending && !validate.isPending ? "Saving…" : "Save server"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border-2 px-3.5 py-2.5 text-[12px] font-medium text-dim transition hover:bg-surface-2"
        >
          Cancel
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onValidate}
          disabled={validate.isPending || save.isPending || !canSave}
          className="flex items-center gap-1.5 rounded-md border border-border-2 px-3.5 py-2.5 text-[12px] font-semibold text-dim transition hover:bg-surface-2 disabled:opacity-60"
        >
          {validate.isPending ? (
            <Spinner className="h-3 w-3" />
          ) : (
            <RefreshCw size={13} />
          )}
          Validate
        </button>
      </div>
    </div>
  );
}

/**
 * The OAuth branch of the server form: an optional scope, a Connect/Reconnect button that saves the server then
 * opens the provider consent popup, and a status line. Tokens are never shown — status is derived from the
 * redacted `oauthConnected` / `needsReauth` flags plus the live popup result.
 */
function OAuthConnect({
  isEdit,
  existing,
  scope,
  onScopeChange,
  busy,
  message,
  onConnect,
}: {
  isEdit: boolean;
  existing: McpServer | null;
  scope: string;
  onScopeChange: (v: string) => void;
  busy: boolean;
  message: { ok: boolean; text: string } | null;
  onConnect: () => void;
}) {
  const connected = existing?.oauthConnected ?? false;
  const needsReauth = existing?.needsReauth ?? false;
  // A brand-new (uncommitted) oauth server has no row yet — the Connect button saves it first, then consents.
  return (
    <div className="mt-3">
      <FormLabel>OAuth scope (optional)</FormLabel>
      <input
        value={scope}
        onChange={(e) => onScopeChange(e.target.value)}
        placeholder="e.g. read:jira-work (leave blank to use the server’s default)"
        className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 font-mono text-[12px] text-text outline-none placeholder:text-faint"
      />
      <div className="mt-3 flex items-center gap-2.5">
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md px-3.5 py-2.5 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
          style={{ background: "var(--accent)" }}
        >
          {busy ? <Spinner className="h-3 w-3" /> : <KeyRound size={13} />}
          {connected || needsReauth ? "Reconnect" : "Connect"}
        </button>
        <OAuthStatus
          connected={connected}
          needsReauth={needsReauth}
          message={message}
        />
      </div>
      {!isEdit ? (
        <div className="mt-2 text-[11px] text-faint">
          The server is saved first, then a provider window opens for you to authorize.
        </div>
      ) : null}
    </div>
  );
}

/** A small status pill for an OAuth server: live popup result wins, else the persisted connected/needs-reauth. */
function OAuthStatus({
  connected,
  needsReauth,
  message,
}: {
  connected: boolean;
  needsReauth: boolean;
  message: { ok: boolean; text: string } | null;
}) {
  if (message) {
    return (
      <span
        className={`flex items-center gap-1.5 text-[11.5px] font-semibold ${message.ok ? "text-green" : "text-red"}`}
      >
        {message.ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
        {message.text}
      </span>
    );
  }
  if (needsReauth) {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-red">
        <AlertCircle size={13} />
        Needs re-auth
      </span>
    );
  }
  if (connected) {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-green">
        <CheckCircle2 size={13} />
        Connected
      </span>
    );
  }
  return <span className="text-[11.5px] text-faint">Not connected</span>;
}

// ── Form building blocks ──────────────────────────────────────────────────────────────────────────
function FormLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`mb-2 block text-[12px] font-medium text-dim ${className}`}
    >
      {children}
    </label>
  );
}

/** stdio args — one input per positional arg, with an index gutter. */
function ArgsEditor({
  rows,
  onChange,
}: {
  rows: string[];
  onChange: (rows: string[]) => void;
}) {
  return (
    <>
      <div className="mb-2 mt-4 flex items-center gap-2">
        <span className="flex-1 text-[12px] font-medium text-dim">Args</span>
        <button
          type="button"
          onClick={() => onChange([...rows, ""])}
          className="rounded-sm border border-accent-line px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-accent-soft"
        >
          + Add arg
        </button>
      </div>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-2">
          {rows.map((a, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-3.5 shrink-0 text-right font-mono text-[10px] text-faint">
                {i}
              </span>
              <input
                value={a}
                onChange={(e) =>
                  onChange(rows.map((r, idx) => (idx === i ? e.target.value : r)))
                }
                placeholder="--flag or value"
                className="flex-1 rounded-md border border-border-2 bg-surface-2 px-2.5 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
              />
              <button
                type="button"
                onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-2 text-faint transition hover:text-red"
                aria-label="Remove arg"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Header / env editor — key + value, each markable secret (lock toggle), stored secrets masked. */
function PairEditor({
  label,
  addLabel,
  keyPlaceholder,
  rows,
  onChange,
}: {
  label: string;
  addLabel: string;
  keyPlaceholder: string;
  rows: PairRow[];
  onChange: (rows: PairRow[]) => void;
}) {
  function patch(i: number, p: Partial<PairRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  }
  return (
    <>
      <div className="mb-2 mt-4 flex items-center gap-2">
        <span className="flex-1 text-[12px] font-medium text-dim">{label}</span>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...rows,
              { k: "", v: "", secret: false, stored: false, revealed: false },
            ])
          }
          className="rounded-sm border border-accent-line px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-accent-soft"
        >
          + {addLabel}
        </button>
      </div>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => {
            const masked = r.secret && r.stored && !r.revealed;
            return (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={r.k}
                  onChange={(e) => patch(i, { k: e.target.value })}
                  placeholder={keyPlaceholder}
                  className="w-[170px] rounded-md border border-border-2 bg-surface-2 px-2.5 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
                />
                {masked ? (
                  <div className="flex flex-1 items-center gap-2 rounded-md border border-border-2 bg-surface-2 px-2.5 py-1.5">
                    <span className="flex-1 font-mono text-[12px] text-dim">
                      •••• (set)
                    </span>
                    <button
                      type="button"
                      onClick={() => patch(i, { revealed: true, v: "" })}
                      className="rounded-sm border border-accent-line px-2 py-1 text-[10.5px] font-semibold text-accent transition hover:bg-accent-soft"
                    >
                      Replace
                    </button>
                  </div>
                ) : (
                  <input
                    value={r.v}
                    onChange={(e) => patch(i, { v: e.target.value })}
                    type={r.secret ? "password" : "text"}
                    placeholder="value"
                    className="flex-1 rounded-md border border-border-2 bg-surface-2 px-2.5 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
                  />
                )}
                <button
                  type="button"
                  onClick={() => patch(i, { secret: !r.secret })}
                  title="Store value as a secret (masked, write-only)"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
                  style={
                    r.secret
                      ? {
                          color: "var(--accent)",
                          borderColor: "var(--accent-line)",
                          background: "var(--accent-soft)",
                        }
                      : {
                          color: "var(--faint)",
                          borderColor: "var(--border-2)",
                        }
                  }
                >
                  <Lock size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-2 text-faint transition hover:text-red"
                  aria-label="Remove row"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="mt-2 text-[10.5px] leading-relaxed text-faint">
        Toggle the lock to store a value as a secret — it renders masked and is
        write-only, like a password.
      </div>
    </>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────────────────────────────
const TRANSPORT_HUE: Record<McpTransport, string> = {
  http: "blue",
  sse: "purple",
  stdio: "green",
};

function TransportBadge({ transport }: { transport: McpTransport }) {
  const hue = TRANSPORT_HUE[transport];
  return (
    <span
      className="rounded-sm border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.03em]"
      style={{
        color: `var(--${hue})`,
        background: `color-mix(in srgb, var(--${hue}) 10%, transparent)`,
        borderColor: `color-mix(in srgb, var(--${hue}) 30%, transparent)`,
      }}
    >
      {transport}
    </span>
  );
}

/** A compact OAuth auth badge for a server row: shows the auth type + connection state at a glance. */
function OAuthBadge({ server }: { server: McpServer }) {
  const state = server.needsReauth
    ? { hue: "red", label: "needs re-auth" }
    : server.oauthConnected
      ? { hue: "green", label: "connected" }
      : { hue: "amber", label: "not connected" };
  return (
    <span
      className="flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px]"
      style={{
        color: `var(--${state.hue})`,
        background: `color-mix(in srgb, var(--${state.hue}) 10%, transparent)`,
        borderColor: `color-mix(in srgb, var(--${state.hue}) 30%, transparent)`,
      }}
    >
      <KeyRound size={10} /> OAuth · {state.label}
    </span>
  );
}

function surfaceLabel(s: McpSurface): string {
  return s === "build" ? "build" : s;
}

/** Derive a row's validation pill (color/text/spinner) from its stored state + any live probe. */
function validationState(
  server: McpServer,
  pending: boolean,
  live: McpValidateResult | undefined,
): { text: string; color: string; bg: string; border: string; spin: boolean; title: string } {
  if (pending)
    return {
      text: "validating…",
      color: "var(--accent)",
      bg: "var(--accent-soft)",
      border: "var(--accent-line)",
      spin: true,
      title: "Validating…",
    };
  const error = live ? live.error : server.validationError;
  const tools = live ? live.discoveredTools : server.discoveredTools;
  const validated = live ? live.ok || Boolean(live.error) : server.lastValidatedAt;

  if (error)
    return {
      text: "failed",
      color: "var(--red)",
      bg: "var(--red-soft)",
      border: "color-mix(in srgb, var(--red) 35%, transparent)",
      spin: false,
      title: error,
    };
  if (validated)
    return {
      text: tools && tools.length > 0 ? `${tools.length} tools` : "validated",
      color: "var(--green)",
      bg: "var(--green-soft)",
      border: "color-mix(in srgb, var(--green) 32%, transparent)",
      spin: false,
      title: "Last validation succeeded",
    };
  return {
    text: "not validated",
    color: "var(--faint)",
    bg: "var(--surface-2)",
    border: "var(--border-2)",
    spin: false,
    title: "Never validated",
  };
}

/** Turn a stored config's header/env map into editable rows (secret values come back withheld). */
function configToRows(bag?: Record<string, string | null>): PairRow[] {
  if (!bag) return [];
  return Object.entries(bag).map(([k, v]) => ({
    k,
    v: v === null ? "" : v,
    secret: v === null,
    stored: v === null,
    revealed: false,
  }));
}

/** Turn editable rows back into the write payload (drops rows with no key). */
function rowsToInput(rows: PairRow[]) {
  return rows
    .filter((r) => r.k.trim())
    .map((r) => ({ name: r.k.trim(), value: r.v, secret: r.secret }));
}

/** A one-line endpoint summary for a server row. */
function endpointLabel(config: StoredMcpConfig, transport: McpTransport): string {
  if (transport === "stdio") {
    return [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
  }
  return config.url ?? "";
}
