"use client";

import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Github,
  KeyRound,
  Lock,
  MessageSquare,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CredentialUsageRing } from "@/features/job-workspace/usage-ring";
import {
  useAddClaudeCredential,
  useClaudeCredentials,
  useCodexAccount,
  useCreateClaudeAuthorizeUrl,
  useDeleteClaudeCredential,
  useOrgCredentials,
  useSaveCredentials,
  useSelectClaudeCredential,
  type ClaudeCredential,
  type ClaudeCredentialKind,
  type ClaudeCredentialStatus,
  type SaveCredentialsBody,
  type SaveCredentialsResult,
} from "@/lib/api/orgs";

/**
 * Credentials — the org-wide encrypted secrets every thread uses. The list is presence-only (the API never
 * returns secret values), so saved keys render fully masked with no last-4. Writing goes through the real
 * `PUT /web/orgs/:orgId/credentials`; the Anthropic key is probed server-side and that verdict is surfaced.
 * Per-key client-side checks are format sanity only.
 *
 * Two distinct purposes, grouped on the page:
 *  - **API keys** (Anthropic + OpenAI) power LangChain one-shot prompts and embeddings.
 *  - **Coding-engine subscriptions** (Claude, and optionally Codex) authenticate the SDK harness that
 *    actually drives the build. The harness runs subscription-only — an API key does NOT authorize it.
 * That's why Anthropic appears twice: an API key for prompts AND a subscription for the coding engine.
 *
 * Claude is the one exception to the presence-only cards above: it manages a full LIST of credentials
 * (see `ClaudeCredentialsManager`) and is owner-gated, since the list surfaces account emails.
 */
export function CredentialsSection({
  orgId,
  role,
}: {
  orgId: string;
  role: string;
}) {
  const { data: presence, isLoading, isError } = useOrgCredentials(orgId);
  const save = useSaveCredentials(orgId);
  const onSave = (body: SaveCredentialsBody) => save.mutateAsync(body);
  const isOwner = role === "owner";
  const { data: codex } = useCodexAccount(orgId, isOwner);

  if (isLoading) {
    return <p className="text-[13px] text-faint">Loading credentials…</p>;
  }
  if (isError || !presence) {
    return <p className="text-[13px] text-red">Couldn’t load credentials.</p>;
  }

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
        Credentials
      </h1>
      <p className="mb-7 mt-1.5 text-[13px] leading-relaxed text-dim">
        Org-wide secrets used by every thread. Encrypted at rest — secret values
        are never shown.
      </p>

      <SectionLabel
        title="Prompts & embeddings"
        hint="API keys for one-shot LLM calls and memory embeddings."
      />

      <CredentialCard
        icon={
          <span className="block h-[11px] w-[11px] rotate-45 rounded-[3px] border-[1.6px] border-accent" />
        }
        iconAccent
        title="Anthropic API key"
        sub="Prompts (LangChain chains) — verified on save"
        present={presence.hasAnthropic}
        pill={
          presence.hasAnthropic
            ? presence.llmValidated
              ? { label: "valid", tone: "green" }
              : { label: "set", tone: "dim" }
            : { label: "not set", tone: "faint" }
        }
        modes={[
          {
            id: "anthropic",
            fieldLabel: "New Anthropic API key",
            placeholder: "sk-ant-api03-…",
            maskedPrefix: "sk-ant-api03-",
            tag: "API key · prompts",
            serverValidated: true,
            help: (
              <HelpBlock>
                <p>
                  Create a key in the{" "}
                  <HelpLink href="https://console.anthropic.com/settings/keys">
                    Anthropic Console
                  </HelpLink>{" "}
                  under <strong>Settings → API keys</strong>. This powers
                  one-shot prompts (job titles, triage) — not the coding engine.
                </p>
                <p>
                  Paste the <Code>sk-ant-api03-…</Code> key it shows (revealed
                  only once).
                </p>
              </HelpBlock>
            ),
            validate: (v) => {
              if (/^sk-ant-oat/.test(v))
                return {
                  ok: false,
                  reason:
                    "That’s a subscription token — add it under “Coding engine” below.",
                };
              if (!v.startsWith("sk-ant-"))
                return {
                  ok: false,
                  reason: "Anthropic keys start with sk-ant-.",
                };
              if (v.length < 25)
                return { ok: false, reason: "That key looks too short." };
              return {
                ok: true,
                reason: "Format looks valid — verifying on save.",
              };
            },
            buildBody: (v) => ({ anthropicApiKey: v }),
          },
        ]}
        onSave={onSave}
      />

      <CredentialCard
        icon={<MessageSquare size={16} />}
        title="OpenAI API key"
        sub="Memory embeddings — required"
        present={presence.hasOpenai}
        pill={
          presence.hasOpenai
            ? { label: "saved", tone: "green" }
            : { label: "required", tone: "faint" }
        }
        modes={[
          {
            id: "openai",
            fieldLabel: "New OpenAI key",
            placeholder: "sk-…",
            maskedPrefix: "sk-proj-",
            tag: "embeddings",
            help: (
              <HelpBlock>
                <p>
                  Create a key on the{" "}
                  <HelpLink href="https://platform.openai.com/api-keys">
                    OpenAI API keys
                  </HelpLink>{" "}
                  page. It powers semantic-memory embeddings — required to
                  activate the org.
                </p>
                <p>
                  Paste the <Code>sk-…</Code> key it shows.
                </p>
              </HelpBlock>
            ),
            validate: (v) => {
              if (/^sk-ant-/.test(v))
                return {
                  ok: false,
                  reason:
                    "That’s an Anthropic key — paste your OpenAI key here.",
                };
              if (!/^sk-/.test(v))
                return { ok: false, reason: "OpenAI keys start with sk-." };
              if (v.length < 20)
                return { ok: false, reason: "That key looks too short." };
              return { ok: true, reason: "Format looks valid." };
            },
            buildBody: (v) => ({ openaiApiKey: v }),
          },
        ]}
        onSave={onSave}
      />

      <SectionLabel
        title="Coding engine"
        hint="Subscription tokens for the agents that drive the build. The engine runs subscription-only — an API key won’t authorize it."
      />

      <ClaudeCredentialsManager orgId={orgId} isOwner={isOwner} />

      <CredentialCard
        icon={<Terminal size={15} />}
        title="Codex subscription"
        sub={
          isOwner && presence.hasCodex && codex?.accountEmail
            ? codex.accountEmail
            : "Optional second coding engine"
        }
        present={presence.hasCodex}
        pill={
          presence.hasCodex
            ? { label: "set", tone: "dim" }
            : { label: "optional", tone: "faint" }
        }
        modes={[
          {
            id: "codex-sub",
            fieldLabel: "New Codex auth token",
            placeholder: "Paste ~/.codex/auth.json…",
            maskedPrefix: "",
            tag: "subscription · optional",
            help: (
              <HelpBlock>
                <p>
                  Sign in to the OpenAI Codex CLI with your{" "}
                  <strong>ChatGPT Plus/Pro</strong> account. With the Codex CLI
                  installed, run:
                </p>
                <CommandLine cmd="codex login" />
                <p>
                  This writes <Code>~/.codex/auth.json</Code> — paste the full
                  contents of that file here.
                </p>
              </HelpBlock>
            ),
            validate: (v) => {
              if (v.length < 10)
                return { ok: false, reason: "That token looks too short." };
              return { ok: true, reason: "Format looks valid." };
            },
            buildBody: (v) => ({ codexAuthSecret: v }),
          },
        ]}
        onSave={onSave}
      />

      <SectionLabel
        title="Source control"
        hint="Repo access for clones, branches and pull requests."
      />

      <CredentialCard
        icon={<Github size={16} />}
        title="GitHub access"
        sub="Personal access token · reads repos, opens PRs"
        present={presence.hasGithub}
        pill={
          presence.hasGithub
            ? { label: "saved", tone: "green" }
            : { label: "not set", tone: "faint" }
        }
        modes={[
          {
            id: "github",
            fieldLabel: "New GitHub token",
            placeholder: "ghp_ or github_pat_…",
            maskedPrefix: "ghp_",
            tag: "repo · read:org",
            help: (
              <HelpBlock>
                <p>
                  Atlas works the repo end-to-end: clone, push branches, and
                  manage pull requests (open, update, comment, merge). It also
                  reads CI / check results and PR comments so it can react to
                  activity on a thread. Create a token at{" "}
                  <HelpLink href="https://github.com/settings/tokens/new">
                    github.com/settings/tokens
                  </HelpLink>
                  :
                </p>
                <p>
                  <strong>Classic</strong> — tick the single <Code>repo</Code>{" "}
                  scope; it covers contents, pull requests, commit statuses,
                  checks and comments. For org repos behind SSO, click{" "}
                  <em>Configure SSO</em> to authorize the token.
                </p>
                <p>
                  <strong>Fine-grained</strong> — grant the repos{" "}
                  <Code>Contents: Read and write</Code>,{" "}
                  <Code>Pull requests: Read and write</Code>,{" "}
                  <Code>Commit statuses: Read</Code>,{" "}
                  <Code>Checks: Read</Code> and{" "}
                  <Code>Webhooks: Read and write</Code> (the last enables
                  real-time PR / CI sync).
                </p>
                <p>
                  Paste the <Code>ghp_…</Code> or <Code>github_pat_…</Code>{" "}
                  token. Live event delivery (webhooks that wake a thread on a
                  comment or CI result) is configured separately.
                </p>
              </HelpBlock>
            ),
            validate: (v) => {
              if (!/^(ghp_|github_pat_)/.test(v))
                return { ok: false, reason: "Expected ghp_ or github_pat_." };
              if (v.length < 20)
                return { ok: false, reason: "That token looks too short." };
              return { ok: true, reason: "Format looks valid." };
            },
            buildBody: (v) => ({ githubPat: v }),
          },
        ]}
        onSave={onSave}
      />
    </>
  );
}

// ── Claude credentials manager ───────────────────────────────────────────────────────────────────
/**
 * The Claude coding-engine auth surface — unlike the other cards here, this manages a LIST of
 * credentials (personal logins + setup-tokens) with one selected to fund the org's turns. Owner-gated:
 * non-owners see the list read-only with no add/select/delete affordances.
 */
function ClaudeCredentialsManager({
  orgId,
  isOwner,
}: {
  orgId: string;
  isOwner: boolean;
}) {
  const {
    data: credentials,
    isLoading,
    isError,
  } = useClaudeCredentials(orgId, isOwner);
  const select = useSelectClaudeCredential(orgId);
  const del = useDeleteClaudeCredential(orgId);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  async function handleDelete(id: string) {
    setDeleteErrors((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    try {
      await del.mutateAsync(id);
    } catch (e) {
      setDeleteErrors((prev) => ({
        ...prev,
        [id]: (e as Error)?.message || "Could not delete credential.",
      }));
    }
  }

  // The list endpoint is owner-only server-side (rows carry account emails), so a member can't view it —
  // show a banner explaining that rather than an empty/errored list.
  if (!isOwner) {
    return (
      <div className="mb-3.5">
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[11.5px] text-faint">
          <Lock size={13} />
          Only organization owners can view and manage Claude credentials.
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3.5">
      {isLoading ? (
        <p className="text-[13px] text-faint">Loading Claude credentials…</p>
      ) : isError || !credentials ? (
        <p className="text-[13px] text-red">
          Couldn’t load Claude credentials.
        </p>
      ) : credentials.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-2 px-3.5 py-3 text-[12px] text-faint">
          No Claude credentials yet — add one below.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {credentials.map((cred) => (
            <ClaudeCredentialRow
              key={cred.id}
              orgId={orgId}
              cred={cred}
              isOwner={isOwner}
              onSelect={() => select.mutate(cred.id)}
              selectPending={select.isPending}
              onDelete={() => handleDelete(cred.id)}
              deletePending={del.isPending}
              deleteError={deleteErrors[cred.id]}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-3">
        <AddClaudePersonalCard orgId={orgId} />
        <AddClaudeSetupTokenCard orgId={orgId} />
      </div>

      <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-faint">
        <strong className="font-semibold text-dim">Setup-tokens</strong> don’t
        expire and are never refreshed — rotate them manually when needed.{" "}
        <strong className="font-semibold text-dim">Personal logins</strong>{" "}
        are refreshed automatically in the background as long as they stay
        connected.
      </p>
    </div>
  );
}

/** One credential row: selected radio, label/badge/status, meta line, and (owner-only) delete. */
function ClaudeCredentialRow({
  orgId,
  cred,
  isOwner,
  onSelect,
  selectPending,
  onDelete,
  deletePending,
  deleteError,
}: {
  orgId: string;
  cred: ClaudeCredential;
  isOwner: boolean;
  onSelect: () => void;
  selectPending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  deleteError?: string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  function handleDeleteClick() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    onDelete();
  }

  return (
    <div
      className="flex items-start gap-3.5 rounded-lg border p-3.5"
      style={
        cred.isSelected
          ? {
              background: "var(--accent-soft)",
              borderColor: "var(--accent-line)",
              boxShadow: "inset 0 0 0 1px var(--accent-line)",
            }
          : { background: "var(--surface)", borderColor: "var(--border)" }
      }
    >
      <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
        {isOwner && !cred.isSelected ? (
          <button
            type="button"
            aria-label="Select credential"
            onClick={onSelect}
            disabled={selectPending}
            className="flex h-4 w-4 items-center justify-center rounded-full border-[1.6px] border-border-2 bg-surface transition disabled:opacity-60"
          />
        ) : (
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full border-[1.6px]"
            style={{
              borderColor: cred.isSelected ? "var(--accent)" : "var(--border-2)",
              background: "var(--surface)",
            }}
          >
            {cred.isSelected ? (
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: "var(--accent)" }}
              />
            ) : null}
          </span>
        )}
        {cred.isSelected ? (
          <span className="whitespace-nowrap font-mono text-[8.5px] uppercase tracking-[0.04em] text-accent">
            selected
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-text">
            {cred.label}
          </span>
          <ClaudeKindBadge kind={cred.kind} />
          <ClaudeStatusChip status={cred.status} />
        </div>
        <div className="mt-1 text-[11.5px] text-faint">
          {claudeCredentialMeta(cred)}
        </div>
        {deleteError ? (
          <p className="mt-1.5 text-[11px] text-red">{deleteError}</p>
        ) : null}
      </div>

      {cred.kind === "personal" ? (
        <div className="flex shrink-0 items-center pt-0.5">
          <CredentialUsageRing orgId={orgId} credentialId={cred.id} />
        </div>
      ) : null}

      {isOwner ? (
        <button
          type="button"
          aria-label="Delete credential"
          onClick={handleDeleteClick}
          disabled={deletePending}
          className="flex h-[30px] shrink-0 items-center justify-center rounded-md border border-border-2 px-2 text-faint transition hover:border-red hover:bg-red-soft hover:text-red disabled:opacity-60"
        >
          {confirmDelete ? (
            <span className="text-[10.5px] font-semibold text-red">
              Confirm?
            </span>
          ) : (
            <Trash2 size={14} />
          )}
        </button>
      ) : null}
    </div>
  );
}

/** Badge distinguishing a personal OAuth login from a long-lived setup-token. */
function ClaudeKindBadge({ kind }: { kind: ClaudeCredentialKind }) {
  const isPersonal = kind === "personal";
  return (
    <span
      className="inline-flex items-center rounded-[4px] border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.03em]"
      style={
        isPersonal
          ? {
              color: "var(--blue)",
              background: "var(--blue-soft)",
              borderColor: "color-mix(in srgb, var(--blue) 30%, transparent)",
            }
          : {
              color: "var(--slate)",
              background: "var(--slate-soft)",
              borderColor: "var(--slate-line)",
            }
      }
    >
      {isPersonal ? "Personal" : "Setup-token"}
    </span>
  );
}

/** Status chip: active (green), needs re-auth (red, warns to reconnect), or error (red). */
function ClaudeStatusChip({
  status,
}: {
  status: ClaudeCredentialStatus | string;
}) {
  if (status === "active") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
        style={{
          color: "var(--green)",
          background: "var(--green-soft)",
          borderColor: "color-mix(in srgb, var(--green) 32%, transparent)",
        }}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--green)" }}
        />
        Active
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        color: "var(--red)",
        background: "var(--red-soft)",
        borderColor: "color-mix(in srgb, var(--red) 35%, transparent)",
      }}
    >
      {status === "needs_reauth" ? <AlertCircle size={11} /> : null}
      {status === "needs_reauth" ? "Needs re-auth" : "Error"}
    </span>
  );
}

/** The row's secondary line: expiry + account for a personal login, or a masked placeholder for a token. */
function claudeCredentialMeta(cred: ClaudeCredential): string {
  if (cred.kind === "setup_token") {
    return "sk-ant-oat01-••••••••••••";
  }
  const emailSuffix = cred.accountEmail ? ` · ${cred.accountEmail}` : "";
  const isExpired =
    cred.status === "needs_reauth" ||
    (cred.expiresAt !== null && cred.expiresAt <= Date.now());
  if (isExpired) {
    const when = cred.expiresAt !== null ? formatClaudeDate(cred.expiresAt) : null;
    return `expired${when ? ` ${when}` : ""}${emailSuffix}`;
  }
  if (cred.expiresAt === null) {
    return `access token${emailSuffix}`;
  }
  return `access token expires in ${formatClaudeDuration(cred.expiresAt - Date.now())}${emailSuffix}`;
}

function formatClaudeDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatClaudeDuration(ms: number): string {
  const minutes = Math.max(Math.round(ms / 60_000), 1);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Step 1 mints a Claude login URL and opens it; step 2 exchanges the pasted `code#state` for a credential. */
function AddClaudePersonalCard({ orgId }: { orgId: string }) {
  const createAuthorizeUrl = useCreateClaudeAuthorizeUrl(orgId);
  const addCredential = useAddClaudeCredential(orgId);
  const [pending, setPending] = useState<{ state: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  async function openLogin() {
    setError("");
    // Open the window synchronously within the click handler so popup blockers don't block it after the
    // mutation's network round-trip loses the user gesture. It must open WITHOUT the "noopener" feature —
    // that makes window.open() return null, leaving no handle to navigate and forcing a post-await open()
    // the popup blocker rejects. We sever the back-reference ourselves via `opener = null` instead.
    const loginWindow = window.open("about:blank", "_blank");
    if (loginWindow) loginWindow.opener = null;
    try {
      const result = await createAuthorizeUrl.mutateAsync();
      if (loginWindow) {
        loginWindow.location.href = result.url;
      } else {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      setPending({ state: result.state });
    } catch (e) {
      loginWindow?.close();
      setError((e as Error)?.message || "Could not start Claude login.");
    }
  }

  async function submitCode() {
    if (!pending) return;
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setError("Paste the code from Claude.");
      return;
    }
    setError("");
    try {
      await addCredential.mutateAsync({
        code: trimmedCode,
        state: pending.state,
      });
      setPending(null);
      setCode("");
    } catch (e) {
      setError((e as Error)?.message || "That code looks expired or invalid.");
    }
  }

  return (
    <div
      className="rounded-lg border p-[18px]"
      style={{
        borderColor: "var(--accent-line)",
        boxShadow: "0 6px 22px var(--accent-soft)",
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md border"
          style={{
            background: "var(--accent-soft)",
            borderColor: "var(--accent-line)",
            color: "var(--accent)",
          }}
        >
          <Sparkles size={14} />
        </span>
        <span className="text-[13.5px] font-semibold text-text">
          Add personal login
        </span>
      </div>

      <div className="mt-4 flex gap-3">
        <StepNumber n={1} />
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">
            Log in with Claude
          </p>
          <button
            type="button"
            onClick={openLogin}
            disabled={createAuthorizeUrl.isPending || Boolean(pending)}
            className="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-[12px] font-semibold text-accent transition hover:bg-accent-soft disabled:opacity-60"
            style={{ borderColor: "var(--accent-line)" }}
          >
            {createAuthorizeUrl.isPending ? "Opening…" : "Open Claude login"}
            <ExternalLink size={12} />
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            Opens Claude in a new tab to log in with your subscription.
          </p>
        </div>
      </div>

      {pending ? (
        <div className="mt-4 flex gap-3">
          <StepNumber n={2} />
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">
              Paste the code back here
            </p>
            <div className="mb-3">
              <label className="mb-1.5 block text-[12px] font-medium text-dim">
                Paste the code from Claude
              </label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                type="text"
                placeholder="code#state"
                className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
              />
            </div>
            <button
              type="button"
              onClick={submitCode}
              disabled={addCredential.isPending}
              className="rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
              style={{ background: "var(--accent)" }}
            >
              {addCredential.isPending ? "Adding…" : "Add credential"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-[11.5px] text-red">{error}</p> : null}
    </div>
  );
}

/** A single "step N" pill used by the personal-login card's two-step flow. */
function StepNumber({ n }: { n: number }) {
  return (
    <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-2 bg-surface-3 font-mono text-[10px] font-semibold text-dim">
      {n}
    </span>
  );
}

/** Compact inline form for a long-lived setup-token, generated via `claude setup-token`. */
function AddClaudeSetupTokenCard({ orgId }: { orgId: string }) {
  const addCredential = useAddClaudeCredential(orgId);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    const trimmedLabel = label.trim();
    const trimmedToken = token.trim();
    if (!trimmedLabel) {
      setError("Enter a label.");
      return;
    }
    if (!trimmedToken.startsWith("sk-ant-oat")) {
      setError("Subscription tokens start with sk-ant-oat.");
      return;
    }
    setError("");
    try {
      await addCredential.mutateAsync({
        label: trimmedLabel,
        setupToken: trimmedToken,
      });
      setLabel("");
      setToken("");
    } catch (e) {
      setError((e as Error)?.message || "Could not add credential.");
    }
  }

  return (
    <div className="rounded-lg border border-border p-[18px]">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-border-2 bg-surface-3 text-dim">
          <KeyRound size={13} />
        </span>
        <span className="text-[13.5px] font-semibold text-text">
          Add setup-token
        </span>
      </div>
      <div className="mt-3 flex items-end gap-2.5">
        <div className="w-[150px] shrink-0">
          <label className="mb-1.5 block text-[12px] font-medium text-dim">
            Label
          </label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            type="text"
            placeholder="e.g. CI pipeline"
            className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2 text-[12.5px] text-text outline-none placeholder:text-faint"
          />
        </div>
        <div className="min-w-0 flex-1">
          <label className="mb-1.5 block text-[12px] font-medium text-dim">
            Token
          </label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="text"
            placeholder="sk-ant-oat01-…"
            className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={addCredential.isPending}
          className="shrink-0 rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
          style={{ background: "var(--accent)" }}
        >
          {addCredential.isPending ? "Adding…" : "Add"}
        </button>
      </div>
      {error ? (
        <p className="mt-2.5 text-[11.5px] text-red">{error}</p>
      ) : null}
      <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
        Generate with <Code>claude setup-token</Code> on a Pro or Max plan.
      </p>
    </div>
  );
}

/** A lightweight group heading separating the credential cards by purpose. */
function SectionLabel({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-2.5 mt-6 first:mt-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-dim">
        {title}
      </h2>
      <p className="mt-1 text-[11.5px] leading-relaxed text-faint">{hint}</p>
    </div>
  );
}

/** "How to get this token" panel shown inside a credential's edit form. */
function HelpBlock({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-md border border-border-2 bg-surface-2 p-3 text-[11.5px] leading-relaxed text-dim">
      {children}
    </div>
  );
}

/** External link to a provider's token/key page inside help copy. */
function HelpLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/** Inline monospace token/path reference inside help copy. */
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[3px] bg-surface-3 px-1 py-0.5 font-mono text-[11px] text-text">
      {children}
    </code>
  );
}

/** A copyable shell command line. */
function CommandLine({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard blocked (e.g. insecure context) — no-op; the command is still selectable.
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
      <span
        aria-hidden
        className="select-none font-mono text-[11px] text-faint"
      >
        $
      </span>
      <code className="flex-1 select-all font-mono text-[12px] text-text">
        {cmd}
      </code>
      <button
        type="button"
        onClick={copy}
        className="flex items-center gap-1 rounded-sm border border-border-2 px-1.5 py-1 text-[10.5px] font-semibold text-dim transition hover:bg-surface-3"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

// ── The card ────────────────────────────────────────────────────────────────────────────────────
interface Mode {
  id: string;
  toggleLabel?: string;
  fieldLabel: string;
  placeholder: string;
  maskedPrefix: string;
  tag: string;
  serverValidated?: boolean;
  /** Optional "how to get this token" guidance, shown inside the edit form. */
  help?: ReactNode;
  validate: (v: string) => { ok: boolean; reason: string };
  buildBody: (v: string) => SaveCredentialsBody;
}

type Tone = "green" | "dim" | "faint";
type Status = "idle" | "testing" | "valid" | "invalid";

function CredentialCard({
  icon,
  iconAccent = false,
  title,
  sub,
  present,
  pill,
  modes,
  onSave,
}: {
  icon: ReactNode;
  iconAccent?: boolean;
  title: string;
  sub: string;
  present: boolean;
  pill: { label: string; tone: Tone };
  modes: Mode[];
  onSave: (body: SaveCredentialsBody) => Promise<SaveCredentialsResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [modeIdx, setModeIdx] = useState(0);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [reason, setReason] = useState("");
  const mode = modes[modeIdx];

  function reset() {
    setValue("");
    setStatus("idle");
    setReason("");
  }
  function startEdit() {
    reset();
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    reset();
  }
  function switchMode(i: number) {
    setModeIdx(i);
    reset();
  }
  function test() {
    const r = mode.validate(value.trim());
    setStatus(r.ok ? "valid" : "invalid");
    setReason(r.reason);
  }
  async function submit() {
    const v = value.trim();
    if (!v) {
      setStatus("invalid");
      setReason("Enter a value.");
      return;
    }
    const r = mode.validate(v);
    if (!r.ok) {
      setStatus("invalid");
      setReason(r.reason);
      return;
    }
    setStatus("testing");
    setReason("");
    try {
      const res = await onSave(mode.buildBody(v));
      const llm = res?.validation?.llmKey;
      if (mode.serverValidated && llm && !llm.ok) {
        setStatus("invalid");
        setReason(llm.reason ?? "Rejected by Anthropic.");
        return;
      }
      setEditing(false);
      reset();
    } catch (e) {
      setStatus("invalid");
      setReason((e as Error)?.message || "Could not save.");
    }
  }

  return (
    <div className="mb-3.5 rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-center gap-3">
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border"
          style={
            iconAccent
              ? {
                  background: "var(--accent-soft)",
                  borderColor: "var(--accent-line)",
                  color: "var(--accent)",
                }
              : {
                  background: "var(--surface-3)",
                  borderColor: "var(--border-2)",
                  color: "var(--dim)",
                }
          }
        >
          {icon}
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-text">{title}</div>
          <div className="mt-0.5 text-[11px] text-faint">{sub}</div>
        </div>
        <StatusChip label={pill.label} tone={pill.tone} />
      </div>

      {!editing ? (
        <>
          <div className="mt-3.5 flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3.5 py-2.5">
            {present ? (
              <>
                <span className="flex-1 font-mono text-[12.5px] text-dim">
                  {mode.maskedPrefix}
                  {"•".repeat(14)}
                </span>
                <span className="rounded-[3px] bg-surface-3 px-1.5 py-0.5 font-mono text-[9px] text-dim">
                  {mode.tag}
                </span>
              </>
            ) : (
              <span className="flex-1 font-mono text-[12px] text-faint">
                No key set.
              </span>
            )}
            <button
              type="button"
              onClick={startEdit}
              className="rounded-sm border border-accent-line px-3 py-1.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent-soft"
            >
              {present ? "Rotate" : "Add key"}
            </button>
          </div>
          {/* When no key is set yet, surface the "how to get this" guidance up front — that's when it's needed. */}
          {!present && mode.help ? (
            <div className="mt-3">{mode.help}</div>
          ) : null}
        </>
      ) : (
        <div className="mt-3.5">
          {modes.length > 1 ? (
            <div className="mb-3 flex gap-1 rounded-md border border-border-2 bg-surface-2 p-1">
              {modes.map((m, i) => {
                const on = i === modeIdx;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => switchMode(i)}
                    className="flex-1 rounded-sm py-1.5 text-[12px] font-semibold transition"
                    style={{
                      background: on ? "var(--surface)" : "transparent",
                      color: on ? "var(--accent)" : "var(--dim)",
                    }}
                  >
                    {m.toggleLabel}
                  </button>
                );
              })}
            </div>
          ) : null}

          {mode.help ? <div className="mb-3">{mode.help}</div> : null}

          <div className="mb-2 flex items-center gap-2">
            <label className="flex-1 text-[12px] font-medium text-dim">
              {mode.fieldLabel}
            </label>
            <EditPill status={status} />
          </div>
          <div
            className="flex items-center rounded-md border bg-surface-2 pl-3 pr-1.5"
            style={{ borderColor: borderForStatus(status) }}
          >
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setStatus("idle");
                setReason("");
              }}
              onBlur={() => {
                if (value.trim() && status === "idle") test();
              }}
              type="password"
              placeholder={mode.placeholder}
              className="flex-1 bg-transparent py-2.5 font-mono text-[12.5px] text-text outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={test}
              className="rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-3"
            >
              Test
            </button>
          </div>
          {reason ? (
            <p
              className="mt-2 text-[11.5px]"
              style={{
                color: status === "valid" ? "var(--green)" : "var(--red)",
              }}
            >
              {reason}
            </p>
          ) : null}
          <div className="mt-3.5 flex gap-2.5">
            <button
              type="button"
              onClick={submit}
              disabled={status === "testing"}
              className="rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
              style={{ background: "var(--accent)" }}
            >
              {status === "testing" ? "Saving…" : "Save new key"}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-border-2 px-3.5 py-2 text-[12px] font-medium text-dim transition hover:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function borderForStatus(status: Status): string {
  if (status === "valid")
    return "color-mix(in srgb, var(--green) 50%, transparent)";
  if (status === "invalid")
    return "color-mix(in srgb, var(--red) 55%, transparent)";
  return "var(--border-2)";
}

function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  const color =
    tone === "green"
      ? "var(--green)"
      : tone === "dim"
        ? "var(--dim)"
        : "var(--faint)";
  const bg = tone === "green" ? "var(--green-soft)" : "var(--surface-2)";
  const border =
    tone === "green"
      ? "color-mix(in srgb, var(--green) 32%, transparent)"
      : "var(--border-2)";
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
      style={{ color, background: bg, borderColor: border }}
    >
      {tone === "green" ? (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--green)" }}
        />
      ) : null}
      {label}
    </span>
  );
}

function EditPill({ status }: { status: Status }) {
  const meta =
    status === "testing"
      ? {
          text: "testing…",
          color: "var(--accent)",
          bg: "var(--accent-soft)",
          border: "var(--accent-line)",
        }
      : status === "valid"
        ? {
            text: "valid",
            color: "var(--green)",
            bg: "var(--green-soft)",
            border: "color-mix(in srgb, var(--green) 35%, transparent)",
          }
        : status === "invalid"
          ? {
              text: "invalid",
              color: "var(--red)",
              bg: "color-mix(in srgb, var(--red) 8%, transparent)",
              border: "color-mix(in srgb, var(--red) 40%, transparent)",
            }
          : {
              text: "not tested",
              color: "var(--faint)",
              bg: "var(--surface-2)",
              border: "var(--border)",
            };
  return (
    <span
      className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[9px]"
      style={{
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
      }}
    >
      {status === "testing" ? <Spinner className="h-2.5 w-2.5" /> : null}
      {meta.text}
    </span>
  );
}
