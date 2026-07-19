'use client';

import { UsageRingView } from '@/features/job-workspace/usage-ring';
import { useQueryClient } from '@/lib/api/_tanstack-shim';
import {
  useDisconnectGithubApp,
  useGithubAppInstallUrl,
  useGithubAppStatus,
  useSetGithubAuthMode,
} from '@/lib/api/orgs';
import { qk } from '@/lib/api/query-keys';
import {
  useCreateClaudePersonalMutation,
  useCreateClaudeSetupTokenMutation,
  useGetAgentCredentialsQuery,
  usePasteCodexAuthMutation,
  usePollCodexDeviceMutation,
  useRemoveAgentCredentialMutation,
  useSetSelectedAgentCredentialMutation,
  useStartClaudeAuthorizeMutation,
  useStartCodexDeviceMutation,
} from '@/redux/query/api/agent-credentials.api';
import {
  useGetCredentialsQuery,
  useSaveCredentialsMutation,
  type SaveCredentialsBody,
} from '@/redux/query/api/credentials.api';
import {
  EAgentProvider,
  type AgentCredentialView,
  type CodexDeviceStartResult,
  type OrgUsage,
} from '@workspace/shared';
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Github,
  KeyRound,
  MessageSquare,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CredentialCard } from './CredentialCard';
import { StatusChip } from './StatusChip';

/** Visual tone for a status pill / chip. */
export type Tone = 'green' | 'dim' | 'faint';
/** Client-side validation status shown by {@link EditPill} for a credential field. */
export type Status = 'idle' | 'testing' | 'valid' | 'invalid';

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
export function CredentialsSection({ orgId, role }: { orgId: string; role: string }) {
  const {
    data: presence,
    isLoading,
    isError,
  } = useGetCredentialsQuery(orgId, {
    skip: !orgId,
  });
  const [save] = useSaveCredentialsMutation();
  const onSave = (body: SaveCredentialsBody) => save({ orgId, body }).unwrap();
  const isOwner = role === 'owner';

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
        Org-wide secrets used by every thread. Encrypted at rest — secret values are never shown.
      </p>

      <SectionLabel
        title="Prompts & embeddings"
        hint="API keys for one-shot LLM calls and memory embeddings."
      />

      <CredentialCard
        icon={
          <span className="block h-2.75 w-2.75 rotate-45 rounded-[3px] border-[1.6px] border-accent" />
        }
        iconAccent
        title="Anthropic API key"
        sub="Prompts (LangChain chains) — verified on save"
        present={presence.hasAnthropic}
        pill={
          presence.hasAnthropic
            ? presence.llmValidated
              ? { label: 'valid', tone: 'green' }
              : { label: 'set', tone: 'dim' }
            : { label: 'not set', tone: 'faint' }
        }
        modes={[
          {
            id: 'anthropic',
            fieldLabel: 'New Anthropic API key',
            placeholder: 'sk-ant-api03-…',
            maskedPrefix: 'sk-ant-api03-',
            tag: 'API key · prompts',
            serverValidated: true,
            help: (
              <HelpBlock>
                <p>
                  Create a key in the{' '}
                  <HelpLink href="https://console.anthropic.com/settings/keys">
                    Anthropic Console
                  </HelpLink>{' '}
                  under <strong>Settings → API keys</strong>. This powers one-shot prompts (job
                  titles, triage) — not the coding engine.
                </p>
                <p>
                  Paste the <Code>sk-ant-api03-…</Code> key it shows (revealed only once).
                </p>
              </HelpBlock>
            ),
            validate: (v) => {
              if (/^sk-ant-oat/.test(v))
                return {
                  ok: false,
                  reason: 'That’s a subscription token — add it under “Coding engine” below.',
                };
              if (!v.startsWith('sk-ant-'))
                return {
                  ok: false,
                  reason: 'Anthropic keys start with sk-ant-.',
                };
              if (v.length < 25) return { ok: false, reason: 'That key looks too short.' };
              return {
                ok: true,
                reason: 'Format looks valid — verifying on save.',
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
            ? { label: 'saved', tone: 'green' }
            : { label: 'required', tone: 'faint' }
        }
        modes={[
          {
            id: 'openai',
            fieldLabel: 'New OpenAI key',
            placeholder: 'sk-…',
            maskedPrefix: 'sk-proj-',
            tag: 'embeddings',
            help: (
              <HelpBlock>
                <p>
                  Create a key on the{' '}
                  <HelpLink href="https://platform.openai.com/api-keys">OpenAI API keys</HelpLink>{' '}
                  page. It powers semantic-memory embeddings — required to activate the org.
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
                  reason: 'That’s an Anthropic key — paste your OpenAI key here.',
                };
              if (!/^sk-/.test(v)) return { ok: false, reason: 'OpenAI keys start with sk-.' };
              if (v.length < 20) return { ok: false, reason: 'That key looks too short.' };
              return { ok: true, reason: 'Format looks valid.' };
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

      <AgentAccountsManager orgId={orgId} isOwner={isOwner} />

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
            ? presence.githubAuthMode === 'app'
              ? { label: 'PAT (inactive)', tone: 'dim' }
              : { label: 'saved', tone: 'green' }
            : { label: 'not set', tone: 'faint' }
        }
        modes={[
          {
            id: 'github',
            fieldLabel: 'New GitHub token',
            placeholder: 'ghp_ or github_pat_…',
            maskedPrefix: 'ghp_',
            tag: 'repo · read:org',
            help: (
              <HelpBlock>
                <p>
                  Atlas works the repo end-to-end: clone, push branches, and manage pull requests
                  (open, update, comment, merge). It also reads CI / check results and PR comments
                  so it can react to activity on a thread. Create a token at{' '}
                  <HelpLink href="https://github.com/settings/tokens/new">
                    github.com/settings/tokens
                  </HelpLink>
                  :
                </p>
                <p>
                  <strong>Classic</strong> — tick the single <Code>repo</Code> scope; it covers
                  contents, pull requests, commit statuses, checks and comments. For org repos
                  behind SSO, click <em>Configure SSO</em> to authorize the token.
                </p>
                <p>
                  <strong>Fine-grained</strong> — grant the repos{' '}
                  <Code>Contents: Read and write</Code>, <Code>Pull requests: Read and write</Code>,{' '}
                  <Code>Commit statuses: Read</Code>, <Code>Checks: Read</Code> and{' '}
                  <Code>Webhooks: Read and write</Code> (the last enables real-time PR / CI sync).
                </p>
                <p>
                  Paste the <Code>ghp_…</Code> or <Code>github_pat_…</Code> token. Live event
                  delivery (webhooks that wake a thread on a comment or CI result) is configured
                  separately.
                </p>
              </HelpBlock>
            ),
            validate: (v) => {
              if (!/^(ghp_|github_pat_)/.test(v))
                return { ok: false, reason: 'Expected ghp_ or github_pat_.' };
              if (v.length < 20) return { ok: false, reason: 'That token looks too short.' };
              return { ok: true, reason: 'Format looks valid.' };
            },
            buildBody: (v) => ({ githubPat: v }),
          },
        ]}
        onSave={onSave}
      />

      <GithubAppConnect orgId={orgId} isOwner={isOwner} hasPat={presence.hasGithub} />
    </>
  );
}

/** Friendly copy for the `?githubApp=error&reason=…` redirect the install callback lands on. */
function githubAppErrorMessage(reason: string | null): string {
  if (reason === 'already_connected')
    return 'That installation is already connected to another organization.';
  if (reason === 'verification_failed')
    return 'Couldn’t verify the installation — try connecting again.';
  return 'The connect request expired or was invalid — try again.';
}

/**
 * The GitHub App is a separate, optional credential from the PAT above: connecting it gives host/background
 * GitHub operations an installation token with its own rate-limit pool. The PAT/App segmented control below
 * explicitly chooses the in-sandbox commit/push/PR identity. Connecting is a redirect flow — `install-url`
 * mints a one-time GitHub install URL, and GitHub's callback lands back here via `?githubApp=connected|error`,
 * which this component picks up on mount.
 */
function GithubAppConnect({
  orgId,
  isOwner,
  hasPat,
}: {
  orgId: string;
  isOwner: boolean;
  hasPat: boolean;
}) {
  const { data: status, isLoading } = useGithubAppStatus(orgId);
  const installUrl = useGithubAppInstallUrl(orgId);
  const setMode = useSetGithubAuthMode(orgId);
  const disconnect = useDisconnectGithubApp(orgId);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const qc = useQueryClient();
  const searchParams = useSearchParams();

  useEffect(() => {
    const result = searchParams.get('githubApp');
    if (result === 'connected') {
      void qc.invalidateQueries({ queryKey: qk.orgGithubAppStatus(orgId) });
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      setNote('GitHub App connected.');
    } else if (result === 'error') {
      setError(githubAppErrorMessage(searchParams.get('reason')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setError('');
    setNote('');
    // Open the window synchronously within the click handler so popup blockers
    // don't block it after the mutation's network round-trip loses the user gesture.
    // Note: passing `noopener`/`noreferrer` here makes window.open return null,
    // which would defeat the synchronous pre-open. Open the blank window without
    // those features and null out `opener` after navigating instead.
    const installWindow = window.open('', '_blank');
    try {
      const result = await installUrl.mutateAsync();
      if (installWindow) {
        installWindow.opener = null;
        installWindow.location.href = result.url;
      } else {
        window.open(result.url, '_blank', 'noopener,noreferrer');
      }
    } catch (e) {
      installWindow?.close();
      setError((e as Error)?.message || 'Could not start the GitHub App install.');
    }
  }

  async function switchMode(mode: 'pat' | 'app') {
    if (!status || status.mode === mode) return;
    setError('');
    setNote('');
    try {
      await setMode.mutateAsync(mode);
    } catch (e) {
      setError((e as Error)?.message || 'Could not switch auth mode.');
    }
  }

  async function handleDisconnectClick() {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    setConfirmDisconnect(false);
    setError('');
    setNote('');
    try {
      await disconnect.mutateAsync();
    } catch (e) {
      setError((e as Error)?.message || 'Could not disconnect the GitHub App.');
    }
  }

  const pill =
    !status || isLoading
      ? { label: '…', tone: 'faint' as const }
      : !status.configured
        ? { label: 'App unavailable', tone: 'faint' as const }
        : status.connected
          ? { label: 'App: connected', tone: 'green' as const }
          : { label: 'not connected', tone: 'faint' as const };

  return (
    <div className="mb-3.5 rounded-lg border border-border bg-surface p-4.5">
      <div className="flex items-center gap-3">
        <span
          className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-lg border"
          style={{
            background: 'var(--surface-3)',
            borderColor: 'var(--border-2)',
            color: 'var(--dim)',
          }}
        >
          <Github size={16} />
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-text">GitHub App</div>
          <div className="mt-0.5 text-[11px] text-faint">
            Its own rate-limit pool — no personal 5k/hr throttling
          </div>
        </div>
        <StatusChip label={pill.label} tone={pill.tone} />
      </div>

      {!status || isLoading ? null : !status.configured ? (
        <p className="mt-3.5 text-[11.5px] text-faint">
          The Atlas GitHub App isn’t configured on this server.
        </p>
      ) : !status.connected ? (
        <div className="mt-3.5">
          <HelpBlock>
            <p>
              App auth routes host and background GitHub traffic through a GitHub App installation
              token, which has its own rate-limit pool separate from any human’s personal 5,000/hr
              budget.
            </p>
            <p>
              After connecting, choose whether sandbox commits, pushes, and PRs use the PAT or the
              App.
            </p>
          </HelpBlock>
          {isOwner ? (
            <button
              type="button"
              onClick={connect}
              disabled={installUrl.isPending}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-[12px] font-semibold text-accent transition hover:bg-accent-soft disabled:opacity-60"
              style={{ borderColor: 'var(--accent-line)' }}
            >
              {installUrl.isPending ? 'Opening…' : 'Connect GitHub App'}
              <ExternalLink size={12} />
            </button>
          ) : (
            <p className="mt-3 text-[11.5px] text-faint">Ask an owner to connect the GitHub App.</p>
          )}
        </div>
      ) : (
        <div className="mt-3.5">
          <p className="text-[11.5px] text-dim">
            Connected to <Code>{status.account ?? `installation #${status.installationId}`}</Code>
          </p>

          <div className="mt-3 flex items-center gap-3">
            <div className="flex gap-1 rounded-md border border-border-2 bg-surface-2 p-1">
              {[
                { id: 'pat' as const, label: 'PAT', disabled: !hasPat },
                {
                  id: 'app' as const,
                  label: 'App',
                  disabled: !status.connected,
                },
              ].map((opt) => {
                const on = status.mode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => switchMode(opt.id)}
                    disabled={!isOwner || opt.disabled || setMode.isPending}
                    className="rounded-sm px-3 py-1.5 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                      background: on ? 'var(--surface)' : 'transparent',
                      color: on ? 'var(--accent)' : 'var(--dim)',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {isOwner ? (
              <button
                type="button"
                onClick={handleDisconnectClick}
                disabled={disconnect.isPending}
                className="flex h-7.5 shrink-0 items-center justify-center rounded-md border border-border-2 px-2.5 text-[11.5px] font-semibold text-faint transition hover:border-red hover:bg-red-soft hover:text-red disabled:opacity-60"
              >
                {confirmDisconnect ? <span className="text-red">Confirm?</span> : 'Disconnect'}
              </button>
            ) : null}
          </div>

          <div className="mt-2.5 text-[11px] text-faint">
            Sets the identity Atlas commits, pushes, and opens PRs as inside the sandbox. Host and
            background traffic (webhooks, CI, PR checks) always uses the App.
          </div>
        </div>
      )}

      {error ? <p className="mt-3 text-[11.5px] text-red">{error}</p> : null}
      {note ? <p className="mt-3 text-[11.5px] text-green">{note}</p> : null}
    </div>
  );
}

/**
 * The coding-engine auth surface — a multi-account manager for Claude AND Codex subscription logins.
 * The list is realtime (streamed from `agent_credentials`) and carries each account's per-account usage
 * windows. Reads are member-visible; add / select / delete are owner-only.
 */
function AgentAccountsManager({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const { data, isLoading, isError } = useGetAgentCredentialsQuery(orgId, { skip: !orgId });
  const [select, selectState] = useSetSelectedAgentCredentialMutation();
  const [remove, removeState] = useRemoveAgentCredentialMutation();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  const onSelect = (id: string) => {
    void select({ orgId, credentialId: id })
      .unwrap()
      .catch(() => {});
  };
  async function onDelete(id: string) {
    setDeleteErrors((p) => {
      const { [id]: _drop, ...rest } = p;
      return rest;
    });
    try {
      await remove({ orgId, id }).unwrap();
    } catch (e) {
      setDeleteErrors((p) => ({ ...p, [id]: errMsg(e, 'Could not delete account.') }));
    }
  }

  if (isLoading) return <p className="mb-3.5 text-[13px] text-faint">Loading agent accounts…</p>;
  if (isError || !data)
    return <p className="mb-3.5 text-[13px] text-red">Couldn’t load agent accounts.</p>;

  const claude = data.filter((c) => c.provider === EAgentProvider.CLAUDE);
  const codex = data.filter((c) => c.provider === EAgentProvider.CODEX);
  const shared = {
    orgId,
    isOwner,
    onSelect,
    onDelete,
    selectPending: selectState.isLoading,
    deletePending: removeState.isLoading,
    deleteErrors,
  };

  return (
    <div className="mb-3.5 flex flex-col gap-6">
      <ClaudeBlock accounts={claude} {...shared} />
      <CodexBlock accounts={codex} {...shared} />
      <p className="border-t border-border pt-3 text-[11px] leading-relaxed text-faint">
        <strong className="font-semibold text-dim">Personal logins</strong> are refreshed
        automatically on the host (including a background keep-alive), so they stay connected
        without an open tab. One that can’t be refreshed shows{' '}
        <strong className="font-semibold text-dim">Needs re-auth</strong>.{' '}
        <strong className="font-semibold text-dim">Setup-tokens</strong> don’t expire and are never
        refreshed — rotate them manually.
      </p>
    </div>
  );
}

type BlockProps = {
  accounts: AgentCredentialView[];
  orgId: string;
  isOwner: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
  selectPending: boolean;
  deletePending: boolean;
  deleteErrors: Record<string, string>;
};

/** Claude sub-block: account list + the two add affordances (personal OAuth login, setup-token). */
function ClaudeBlock({
  accounts,
  orgId,
  isOwner,
  onSelect,
  onDelete,
  selectPending,
  deletePending,
  deleteErrors,
}: BlockProps) {
  const login = useClaudeLogin(orgId);
  const cardRef = useRef<HTMLDivElement>(null);
  function handleReconnect() {
    login.openLogin();
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return (
    <div>
      <ProviderHeading
        icon={<Sparkles size={14} />}
        title="Claude"
        sub="Anthropic subscription — powers Claude Code turns"
      />
      <AccountList
        accounts={accounts}
        orgId={orgId}
        isOwner={isOwner}
        onSelect={onSelect}
        onDelete={onDelete}
        selectPending={selectPending}
        deletePending={deletePending}
        deleteErrors={deleteErrors}
        onReconnect={handleReconnect}
        emptyHint="No Claude accounts yet — add one below."
      />
      {isOwner ? (
        <div className="mt-3 flex flex-col gap-3">
          <AddClaudePersonalCard login={login} cardRef={cardRef} />
          <AddClaudeSetupTokenCard orgId={orgId} />
        </div>
      ) : null}
    </div>
  );
}

/** Codex sub-block: account list + device-code login and the paste-auth.json fallback. */
function CodexBlock({
  accounts,
  orgId,
  isOwner,
  onSelect,
  onDelete,
  selectPending,
  deletePending,
  deleteErrors,
}: BlockProps) {
  return (
    <div>
      <ProviderHeading
        icon={<Terminal size={14} />}
        title="Codex"
        sub="OpenAI ChatGPT subscription — optional second engine"
      />
      <AccountList
        accounts={accounts}
        orgId={orgId}
        isOwner={isOwner}
        onSelect={onSelect}
        onDelete={onDelete}
        selectPending={selectPending}
        deletePending={deletePending}
        deleteErrors={deleteErrors}
        emptyHint="No Codex accounts yet — optional."
      />
      {isOwner ? (
        <div className="mt-3 flex flex-col gap-3">
          <AddCodexDeviceCard orgId={orgId} />
          <AddCodexPasteCard orgId={orgId} />
        </div>
      ) : null}
    </div>
  );
}

function ProviderHeading({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-border-2 bg-surface-3 text-dim">
        {icon}
      </span>
      <div>
        <div className="text-[13px] font-semibold text-text">{title}</div>
        <div className="text-[11px] text-faint">{sub}</div>
      </div>
    </div>
  );
}

function AccountList({
  accounts,
  isOwner,
  onSelect,
  onDelete,
  selectPending,
  deletePending,
  deleteErrors,
  onReconnect,
  emptyHint,
}: BlockProps & { onReconnect?: () => void; emptyHint: string }) {
  if (accounts.length === 0)
    return (
      <p className="rounded-lg border border-border bg-surface-2 px-3.5 py-3 text-[12px] text-faint">
        {emptyHint}
      </p>
    );
  return (
    <div className="flex flex-col gap-2.5">
      {accounts.map((cred) => (
        <AgentAccountRow
          key={cred.id}
          cred={cred}
          isOwner={isOwner}
          onSelect={() => onSelect(cred.id)}
          selectPending={selectPending}
          onDelete={() => onDelete(cred.id)}
          deletePending={deletePending}
          deleteError={deleteErrors[cred.id]}
          onReconnect={onReconnect}
        />
      ))}
    </div>
  );
}

/** One account row: selected radio, label/badge/status, meta, per-account usage bars, owner delete. */
function AgentAccountRow({
  cred,
  isOwner,
  onSelect,
  selectPending,
  onDelete,
  deletePending,
  deleteError,
  onReconnect,
}: {
  cred: AgentCredentialView;
  isOwner: boolean;
  onSelect: () => void;
  selectPending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  deleteError?: string;
  onReconnect?: () => void;
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
        cred.selected
          ? {
              background: 'var(--accent-soft)',
              borderColor: 'var(--accent-line)',
              boxShadow: 'inset 0 0 0 1px var(--accent-line)',
            }
          : { background: 'var(--surface)', borderColor: 'var(--border)' }
      }
    >
      <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
        {isOwner && !cred.selected ? (
          <button
            type="button"
            aria-label="Select account"
            onClick={onSelect}
            disabled={selectPending}
            className="flex h-4 w-4 items-center justify-center rounded-full border-[1.6px] border-border-2 bg-surface transition disabled:opacity-60"
          />
        ) : (
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full border-[1.6px]"
            style={{
              borderColor: cred.selected ? 'var(--accent)' : 'var(--border-2)',
              background: 'var(--surface)',
            }}
          >
            {cred.selected ? (
              <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent)' }} />
            ) : null}
          </span>
        )}
        {cred.selected ? (
          <span className="whitespace-nowrap font-mono text-[8.5px] uppercase tracking-[0.04em] text-accent">
            selected
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-text">{cred.label}</span>
          <AgentKindBadge kind={cred.kind} />
          <AgentStatusChip status={cred.status} />
        </div>
        <div className="mt-1 text-[11.5px] text-faint">{agentMeta(cred)}</div>
        {deleteError ? <p className="mt-1.5 text-[11px] text-red">{deleteError}</p> : null}
      </div>

      {cred.kind === 'personal' ? (
        <div className="shrink-0 pt-0.5">
          <UsageRingView data={toRingData(cred)} isLoading={false} />
        </div>
      ) : null}

      {isOwner && onReconnect && cred.kind === 'personal' && cred.status === 'needs_reauth' ? (
        <button
          type="button"
          onClick={onReconnect}
          className="flex h-7.5 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent-soft"
          style={{ borderColor: 'var(--accent-line)' }}
        >
          Reconnect
          <ExternalLink size={12} />
        </button>
      ) : null}

      {isOwner ? (
        <button
          type="button"
          aria-label="Delete account"
          onClick={handleDeleteClick}
          disabled={deletePending}
          className="flex h-7.5 shrink-0 items-center justify-center rounded-md border border-border-2 px-2 text-faint transition hover:border-red hover:bg-red-soft hover:text-red disabled:opacity-60"
        >
          {confirmDelete ? (
            <span className="text-[10.5px] font-semibold text-red">Confirm?</span>
          ) : (
            <Trash2 size={14} />
          )}
        </button>
      ) : null}
    </div>
  );
}

/** Badge distinguishing a personal OAuth login from a long-lived setup-token. */
function AgentKindBadge({ kind }: { kind: AgentCredentialView['kind'] }) {
  const isPersonal = kind === 'personal';
  return (
    <span
      className="inline-flex items-center rounded-[4px] border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.03em]"
      style={
        isPersonal
          ? {
              color: 'var(--blue)',
              background: 'var(--blue-soft)',
              borderColor: 'color-mix(in srgb, var(--blue) 30%, transparent)',
            }
          : {
              color: 'var(--slate)',
              background: 'var(--slate-soft)',
              borderColor: 'var(--slate-line)',
            }
      }
    >
      {isPersonal ? 'Personal' : 'Setup-token'}
    </span>
  );
}

/** Status chip: active (green), needs re-auth (red), or error (red). */
function AgentStatusChip({ status }: { status: AgentCredentialView['status'] }) {
  if (status === 'active') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
        style={{
          color: 'var(--green)',
          background: 'var(--green-soft)',
          borderColor: 'color-mix(in srgb, var(--green) 32%, transparent)',
        }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--green)' }} />
        Active
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        color: 'var(--red)',
        background: 'var(--red-soft)',
        borderColor: 'color-mix(in srgb, var(--red) 35%, transparent)',
      }}
    >
      {status === 'needs_reauth' ? <AlertCircle size={11} /> : null}
      {status === 'needs_reauth' ? 'Needs re-auth' : 'Error'}
    </span>
  );
}

/** The row's secondary line: expiry + account for a personal login, or a masked token placeholder. */
function agentMeta(cred: AgentCredentialView): string {
  if (cred.kind === 'setup_token') return 'sk-ant-oat01-••••••••••••';
  const emailSuffix = cred.accountEmail ? ` · ${cred.accountEmail}` : '';
  if (cred.status === 'needs_reauth') return `needs re-auth${emailSuffix}`;
  if (cred.expiresAt === null) return `active${emailSuffix}`;
  const ms = new Date(cred.expiresAt).getTime() - Date.now();
  if (ms <= 0) return `expired${emailSuffix}`;
  return `token expires in ${formatDuration(ms)}${emailSuffix}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(Math.round(ms / 60_000), 1);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Feed the shared usage ring ({@link UsageRingView}) from a streamed account — its per-account 5h/weekly
 * windows plus the account/plan header. Returns undefined when there's no snapshot yet, so the ring shows
 * its own "unknown" state (Codex accounts stay there until the engine harvests their rate limits).
 */
function toRingData(cred: AgentCredentialView): OrgUsage | undefined {
  if (!cred.usage) return undefined;
  return {
    ...cred.usage,
    accountLabel: cred.accountEmail ?? undefined,
    plan: cred.plan ?? undefined,
  };
}

/**
 * The two-step Claude personal-login flow as a hook, so both the add-card and a row's Reconnect button
 * drive ONE shared login: step 1 mints a Claude login URL and opens it; step 2 exchanges the pasted
 * `code#state` for a credential (the backend re-keys by account email, so reconnecting revives the
 * same row to `active`).
 */
function useClaudeLogin(orgId: string) {
  const [startAuth, startState] = useStartClaudeAuthorizeMutation();
  const [createPersonal, createState] = useCreateClaudePersonalMutation();
  const [pending, setPending] = useState<{ state: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  async function openLogin() {
    setError('');
    // Open the window synchronously within the click handler so popup blockers don't block it after the
    // mutation's network round-trip loses the user gesture. Open WITHOUT "noopener" (which returns null),
    // then sever the back-reference via `opener = null`.
    const loginWindow = window.open('about:blank', '_blank');
    if (loginWindow) loginWindow.opener = null;
    try {
      const result = await startAuth({ orgId }).unwrap();
      if (loginWindow) loginWindow.location.href = result.url;
      else window.open(result.url, '_blank', 'noopener,noreferrer');
      setPending({ state: result.state });
    } catch (e) {
      loginWindow?.close();
      setError(errMsg(e, 'Could not start Claude login.'));
    }
  }

  async function submitCode() {
    if (!pending) return;
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setError('Paste the code from Claude.');
      return;
    }
    setError('');
    try {
      await createPersonal({ orgId, code: trimmedCode, state: pending.state }).unwrap();
      setPending(null);
      setCode('');
    } catch (e) {
      setError(errMsg(e, 'That code looks expired or invalid.'));
    }
  }

  return {
    openLogin,
    submitCode,
    pending,
    code,
    setCode,
    error,
    isOpeningLogin: startState.isLoading,
    isAddingCredential: createState.isLoading,
  };
}

type ClaudeLogin = ReturnType<typeof useClaudeLogin>;

/** Renders the shared personal-login flow as a card; owns no login state (the hook does). */
function AddClaudePersonalCard({
  login,
  cardRef,
}: {
  login: ClaudeLogin;
  cardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const {
    openLogin,
    submitCode,
    pending,
    code,
    setCode,
    error,
    isOpeningLogin,
    isAddingCredential,
  } = login;

  return (
    <div
      ref={cardRef}
      className="rounded-lg border p-4.5"
      style={{ borderColor: 'var(--accent-line)', boxShadow: '0 6px 22px var(--accent-soft)' }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="flex h-6.5 w-6.5 items-center justify-center rounded-md border"
          style={{
            background: 'var(--accent-soft)',
            borderColor: 'var(--accent-line)',
            color: 'var(--accent)',
          }}
        >
          <Sparkles size={14} />
        </span>
        <span className="text-[13.5px] font-semibold text-text">Add personal login</span>
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
            disabled={isOpeningLogin || Boolean(pending)}
            className="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-[12px] font-semibold text-accent transition hover:bg-accent-soft disabled:opacity-60"
            style={{ borderColor: 'var(--accent-line)' }}
          >
            {isOpeningLogin ? 'Opening…' : 'Open Claude login'}
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
              disabled={isAddingCredential}
              className="rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
              style={{ background: 'var(--accent)' }}
            >
              {isAddingCredential ? 'Adding…' : 'Add account'}
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

/** Compact inline form for a long-lived Claude setup-token, generated via `claude setup-token`. */
function AddClaudeSetupTokenCard({ orgId }: { orgId: string }) {
  const [add, { isLoading }] = useCreateClaudeSetupTokenMutation();
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    const trimmedLabel = label.trim();
    const trimmedToken = token.trim();
    if (!trimmedToken.startsWith('sk-ant-oat')) {
      setError('Subscription tokens start with sk-ant-oat.');
      return;
    }
    setError('');
    try {
      await add({ orgId, setupToken: trimmedToken, label: trimmedLabel || undefined }).unwrap();
      setLabel('');
      setToken('');
    } catch (e) {
      setError(errMsg(e, 'Could not add setup-token.'));
    }
  }

  return (
    <div className="rounded-lg border border-border p-4.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-border-2 bg-surface-3 text-dim">
          <KeyRound size={13} />
        </span>
        <span className="text-[13.5px] font-semibold text-text">Add setup-token</span>
      </div>
      <div className="mt-3 flex items-end gap-2.5">
        <div className="w-37.5 shrink-0">
          <label className="mb-1.5 block text-[12px] font-medium text-dim">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            type="text"
            placeholder="e.g. CI pipeline"
            className="w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2 text-[12.5px] text-text outline-none placeholder:text-faint"
          />
        </div>
        <div className="min-w-0 flex-1">
          <label className="mb-1.5 block text-[12px] font-medium text-dim">Token</label>
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
          disabled={isLoading}
          className="shrink-0 rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
          style={{ background: 'var(--accent)' }}
        >
          {isLoading ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? <p className="mt-2.5 text-[11.5px] text-red">{error}</p> : null}
      <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
        Generate with <Code>claude setup-token</Code> on a Pro or Max plan.
      </p>
    </div>
  );
}

/** Codex device-code login: start → show the code + link → poll until the account connects. */
function AddCodexDeviceCard({ orgId }: { orgId: string }) {
  const [start, { isLoading: starting }] = useStartCodexDeviceMutation();
  const [poll] = usePollCodexDeviceMutation();
  const [device, setDevice] = useState<CodexDeviceStartResult | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function schedulePoll(d: CodexDeviceStartResult) {
    const delayMs = Math.max(d.interval, 3) * 1000;
    timer.current = setTimeout(async () => {
      try {
        const r = await poll({ orgId, handle: d.handle }).unwrap();
        if (r.status === 'complete') {
          setDevice(null);
          setNote('Codex account connected.');
          return;
        }
        if (r.status === 'expired') {
          setDevice(null);
          setError('The code expired — start again.');
          return;
        }
        if (r.status === 'denied') {
          setDevice(null);
          setError('Sign-in was denied.');
          return;
        }
        schedulePoll(d); // pending / slow_down
      } catch (e) {
        setDevice(null);
        setError(errMsg(e, 'Codex login failed.'));
      }
    }, delayMs);
  }

  async function begin() {
    setError('');
    setNote('');
    try {
      const d = await start({ orgId }).unwrap();
      setDevice(d);
      schedulePoll(d);
    } catch (e) {
      setError(errMsg(e, 'Could not start Codex login.'));
    }
  }

  return (
    <div
      className="rounded-lg border p-4.5"
      style={{ borderColor: 'var(--accent-line)', boxShadow: '0 6px 22px var(--accent-soft)' }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="flex h-6.5 w-6.5 items-center justify-center rounded-md border"
          style={{
            background: 'var(--accent-soft)',
            borderColor: 'var(--accent-line)',
            color: 'var(--accent)',
          }}
        >
          <Terminal size={14} />
        </span>
        <span className="text-[13.5px] font-semibold text-text">Sign in with ChatGPT</span>
      </div>

      {device ? (
        <div className="mt-3">
          <p className="text-[12px] text-dim">
            Open <HelpLink href={device.verificationUri}>{device.verificationUri}</HelpLink> and
            enter this code:
          </p>
          <div className="mt-2 inline-block rounded-md border border-border-2 bg-surface-2 px-4 py-2 font-mono text-[18px] font-semibold tracking-[0.12em] text-text">
            {device.userCode}
          </div>
          <p className="mt-2 flex items-center gap-2 text-[11.5px] text-faint">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Waiting for you to approve in ChatGPT…
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <HelpBlock>
            <p>
              Signs in with your <strong>ChatGPT Plus/Pro</strong> subscription via a one-time
              device code — no CLI needed. First enable <strong>“Sign in with device code”</strong>{' '}
              in your ChatGPT security settings.
            </p>
          </HelpBlock>
          <button
            type="button"
            onClick={begin}
            disabled={starting}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-[12px] font-semibold text-accent transition hover:bg-accent-soft disabled:opacity-60"
            style={{ borderColor: 'var(--accent-line)' }}
          >
            {starting ? 'Starting…' : 'Sign in with ChatGPT'}
            <ExternalLink size={12} />
          </button>
        </div>
      )}

      {error ? <p className="mt-3 text-[11.5px] text-red">{error}</p> : null}
      {note ? <p className="mt-3 text-[11.5px] text-green">{note}</p> : null}
    </div>
  );
}

/** Fallback: paste the full `~/.codex/auth.json` from a local `codex login`. */
function AddCodexPasteCard({ orgId }: { orgId: string }) {
  const [paste, { isLoading }] = usePasteCodexAuthMutation();
  const [label, setLabel] = useState('');
  const [authJson, setAuthJson] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    const trimmed = authJson.trim();
    if (trimmed.length < 10) {
      setError('Paste the full contents of ~/.codex/auth.json.');
      return;
    }
    setError('');
    try {
      await paste({ orgId, authJson: trimmed, label: label.trim() || undefined }).unwrap();
      setLabel('');
      setAuthJson('');
    } catch (e) {
      setError(errMsg(e, 'Could not add Codex account.'));
    }
  }

  return (
    <div className="rounded-lg border border-border p-4.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-border-2 bg-surface-3 text-dim">
          <KeyRound size={13} />
        </span>
        <span className="text-[13.5px] font-semibold text-text">Paste auth.json (fallback)</span>
      </div>
      <HelpBlock>
        <p>Or sign in with the Codex CLI locally and paste the file. Run:</p>
        <CommandLine cmd="codex login" />
        <p>
          This writes <Code>~/.codex/auth.json</Code> — paste its full contents below.
        </p>
      </HelpBlock>
      <div className="mt-3">
        <label className="mb-1.5 block text-[12px] font-medium text-dim">Label (optional)</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          type="text"
          placeholder="e.g. work ChatGPT"
          className="mb-2.5 w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2 text-[12.5px] text-text outline-none placeholder:text-faint"
        />
        <label className="mb-1.5 block text-[12px] font-medium text-dim">auth.json</label>
        <textarea
          value={authJson}
          onChange={(e) => setAuthJson(e.target.value)}
          rows={3}
          placeholder='{"tokens":{"id_token":"…","access_token":"…","refresh_token":"…"}}'
          className="w-full resize-y rounded-md border border-border-2 bg-surface-2 px-3 py-2 font-mono text-[11px] text-text outline-none placeholder:text-faint"
        />
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={isLoading}
        className="mt-2.5 rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
        style={{ background: 'var(--accent)' }}
      >
        {isLoading ? 'Adding…' : 'Add Codex account'}
      </button>
      {error ? <p className="mt-2.5 text-[11.5px] text-red">{error}</p> : null}
    </div>
  );
}

/** Extract a human message from an RTK/axios mutation error. */
function errMsg(e: unknown, fallback: string): string {
  return (e as { data?: { message?: string } })?.data?.message ?? (e as Error)?.message ?? fallback;
}

/** A lightweight group heading separating the credential cards by purpose. */
function SectionLabel({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-2.5 mt-6 first:mt-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-dim">{title}</h2>
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
      <span aria-hidden className="select-none font-mono text-[11px] text-faint">
        $
      </span>
      <code className="flex-1 select-all font-mono text-[12px] text-text">{cmd}</code>
      <button
        type="button"
        onClick={copy}
        className="flex items-center gap-1 rounded-sm border border-border-2 px-1.5 py-1 text-[10.5px] font-semibold text-dim transition hover:bg-surface-3"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
