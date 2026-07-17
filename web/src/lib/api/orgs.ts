"use client";

import {
  useCreateOrgMutation,
  useDeleteOrgMutation,
  useGetOrgMembersQuery,
  useUpdateOrgMutation,
} from "@/redux/query/api/org.api";
import { env } from "@/lib/env";
import { type AutoMergeMethod, type UpdateOrgDto } from "@workspace/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adaptMutation, adaptQuery, stubMutation, type MutationResultLike } from "./_stub";
import {
  useConnectRepoMutation,
  useDisconnectRepoMutation,
  useRevalidateRepoMutation,
  useUpdateRepoMutation,
} from "@/redux/query/api/repo.api";
import { useMutation, useQuery, useQueryClient } from "./_tanstack-shim";
import type { OrgSummary } from "./me";
import { fetchWithRefresh } from "./refresh";
import { qk } from "./query-keys";
import type { WireOrgUsage } from "./types";
import { readUsageCache, removeUsageCache, usePersistUsage } from "./usage-cache";

/**
 * Org-scoped reads + the credentials write for the settings page. All hit the Atlas app directly with the
 * session cookie; `/web/orgs/:orgId/*` is membership-gated server-side (403 for non-members), writes
 * (credentials PUT) are owner-only. Secrets are never returned — credentials GET is presence flags only.
 */

const BASE = `${env.NEXT_PUBLIC_BACKEND_URL}/web`;

const usageCacheKey = (key: readonly string[]) => key.join(":");

async function webJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithRefresh(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Members ──────────────────────────────────────────────────────────────────────────────────────
export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

// WIRED (RTK): GET /orgs/:orgId/members
export function useOrgMembers(orgId: string) {
  return adaptQuery(useGetOrgMembersQuery(orgId, { skip: !orgId }));
}

// ── Credentials (presence only — never the secret values) ────────────────────────────────────────
export interface CredentialPresence {
  hasAnthropic: boolean;
  hasOpenai: boolean;
  hasGithub: boolean;
  /** A Claude coding-engine subscription token is set (the primary, required coding engine). */
  engineAuthSet: boolean;
  /** An optional Codex coding-engine subscription is set. */
  hasCodex: boolean;
  /** The org has connected the Atlas GitHub App (a non-null installation id). */
  hasGithubApp: boolean;
  /** Which GitHub credential resolves for this org: `pat` (default) or `app`. */
  githubAuthMode: "pat" | "app";
  llmValidated: boolean;
}

export function useOrgCredentials(orgId: string) {
  return useQuery({
    queryKey: qk.orgCredentials(orgId),
    queryFn: () => webJson<CredentialPresence>(`/orgs/${orgId}/credentials`),
    enabled: Boolean(orgId),
    staleTime: 15_000,
  });
}

// ── GitHub App (connect the platform Atlas App as host/background auth and optional sandbox auth) ─────
// One platform-level Atlas GitHub App; an org INSTALLS it and Atlas stores a non-secret installation id
// plus a `githubAuthMode` (pat|app). Host/background calls use the App token whenever connected; the
// `githubAuthMode` setting explicitly chooses sandbox commit/push/PR identity. `configured` reflects whether
// the platform App env is set server-side; when false the connect affordance hides. Connecting is a redirect
// flow: `install-url` mints a nonce-backed GitHub install URL, the owner installs, and GitHub redirects back
// to the settings page (`?githubApp=…`). Every write is owner-only server-side; `status` is member-readable
// (no secrets).

/** Connect state for the settings card (`GET …/github-app/status`) — never any secret value. */
export interface GithubAppStatus {
  /** The platform Atlas App env is configured server-side (app id + key). When false, hide Connect. */
  configured: boolean;
  /** This org has a connected installation. */
  connected: boolean;
  /** The org's active GitHub credential. */
  mode: "pat" | "app";
  /** The connected installation id (plaintext, non-secret); null when not connected. */
  installationId: string | null;
  /** The installation's GitHub account login (display) — null when not connected. */
  account: string | null;
}

export function useGithubAppStatus(orgId: string) {
  return useQuery({
    queryKey: qk.orgGithubAppStatus(orgId),
    queryFn: () => webJson<GithubAppStatus>(`/orgs/${orgId}/github-app/status`),
    enabled: Boolean(orgId),
    staleTime: 15_000,
  });
}

/**
 * Owner-only: mint the org's single-use GitHub App install URL. Does not persist anything — the install
 * lands on GitHub's redirect back to the settings page, which the backend callback verifies + stores.
 */
export function useGithubAppInstallUrl(orgId: string) {
  return useMutation({
    mutationFn: () =>
      webJson<{ url: string }>(`/orgs/${orgId}/github-app/install-url`, {
        method: "POST",
      }),
  });
}

/**
 * Owner-only: switch the resolved GitHub credential between `pat` and `app`. `app` requires a connected
 * installation server-side. Invalidates presence + status (the mode drives which credential authenticates)
 * and the session (mode can flip the onboarding checklist).
 */
export function useSetGithubAuthMode(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: "pat" | "app") =>
      webJson<{ ok: true; mode: "pat" | "app" }>(`/orgs/${orgId}/github-app/mode`, {
        method: "PUT",
        body: JSON.stringify({ mode }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgGithubAppStatus(orgId) });
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}

/**
 * Owner-only: disconnect the App — clears the installation and falls back to `pat` mode. Invalidates
 * presence + status + session (the org may fall back onto its PAT, or lose GitHub access if it had none).
 */
export function useDisconnectGithubApp(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      webJson<{ ok: true }>(`/orgs/${orgId}/github-app`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgGithubAppStatus(orgId) });
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}

// ── Claude credentials (multi-credential manager — the primary coding-engine auth surface) ─────────
// The org keeps a LIST of Claude credentials; ONE is selected and funds all of the org's turns. Rows are
// summaries only — token values are never returned. Owner-only server-side (list included; it exposes
// account emails). Two kinds: `setup_token` (long-lived, never refreshed) and `personal` (OAuth login,
// short-lived access token auto-refreshed in-container). Adding a personal login is a two-step flow:
// `POST /authorize-url` mints the login URL, the operator logs in + pastes the returned `code#state`,
// then `POST /` exchanges it. Adding a setup-token is a single `POST /` with the `sk-ant-oat…` value.

export type ClaudeCredentialKind = "setup_token" | "personal";
export type ClaudeCredentialStatus = "active" | "needs_reauth" | "error";

/** A Claude credential row — a summary only; secret VALUES are never returned by the API. */
export interface ClaudeCredential {
  id: string;
  label: string;
  kind: ClaudeCredentialKind;
  status: ClaudeCredentialStatus | string;
  /** Personal-login access-token expiry (epoch ms); null for setup-tokens. */
  expiresAt: number | null;
  /** Personal-login account email (display only); null for setup-tokens. */
  accountEmail: string | null;
  /** Whether this credential is the org's active (selected) one. */
  isSelected: boolean;
}

/**
 * The org's Claude credential list. The endpoint is owner-only server-side (rows expose account emails),
 * so pass `enabled: false` for non-owners to skip a guaranteed 403 — they get a banner, not the list.
 */
export function useClaudeCredentials(orgId: string, enabled = true) {
  return useQuery({
    queryKey: qk.orgClaudeCredentials(orgId),
    queryFn: () =>
      webJson<ClaudeCredential[]>(`/orgs/${orgId}/claude-credentials`),
    enabled: Boolean(orgId) && enabled,
    staleTime: 15_000,
  });
}

/** The server response for `POST /authorize-url`: the Claude login URL + the PKCE `state` to echo back. */
export interface ClaudeAuthorizeUrl {
  url: string;
  state: string;
}

/**
 * Owner-only: step 1 of adding a personal login. Mints a PKCE-backed Claude login URL; the operator opens
 * it, logs in with their subscription, and pastes the returned code. Takes no body — a personal credential
 * is named by the account email captured from the token exchange, not by an operator-supplied label. Does
 * not invalidate the list (nothing is stored yet — the credential lands on the follow-up
 * `useAddClaudeCredential` exchange).
 */
export function useCreateClaudeAuthorizeUrl(orgId: string) {
  return useMutation({
    mutationFn: () =>
      webJson<ClaudeAuthorizeUrl>(`/orgs/${orgId}/claude-credentials/authorize-url`, {
        method: "POST",
      }),
  });
}

/** Body for `POST /claude-credentials` — a personal login (`code`+`state`) OR a setup-token (`setupToken`). */
export type AddClaudeCredentialBody =
  | { code: string; state: string }
  | { label: string; setupToken: string };

/**
 * Owner-only: create a credential — the personal-login exchange (`{code, state}`, named by account email) or
 * a setup-token (`{setupToken, label}`). The server auto-selects it when it's the org's first. Invalidates
 * the list + the presence/session queries (a first credential flips the onboarding checklist).
 */
export function useAddClaudeCredential(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddClaudeCredentialBody) =>
      webJson<ClaudeCredential>(`/orgs/${orgId}/claude-credentials`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (credential) => {
      removeUsageCache(usageCacheKey(qk.orgCredentialUsage(orgId, credential.id)));
      if (credential.isSelected) removeUsageCache(usageCacheKey(qk.orgUsage(orgId)));
      void qc.invalidateQueries({ queryKey: qk.orgClaudeCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.session() });
      void qc.invalidateQueries({ queryKey: qk.orgUsage(orgId) });
    },
  });
}

/** Owner-only: set the org's active credential. Invalidates the list + presence/session (selection drives auth). */
export function useSelectClaudeCredential(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credentialId: string) =>
      webJson<{ ok: true }>(`/orgs/${orgId}/claude-credentials/selected`, {
        method: "PUT",
        body: JSON.stringify({ credentialId }),
      }),
    onSuccess: () => {
      removeUsageCache(usageCacheKey(qk.orgUsage(orgId)));
      void qc.invalidateQueries({ queryKey: qk.orgClaudeCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.session() });
      void qc.invalidateQueries({ queryKey: qk.orgUsage(orgId) });
      void qc.invalidateQueries({ queryKey: ["org-credential-usage", orgId] });
    },
  });
}

/** Owner-only: delete a credential. Deleting the selected one clears the org pointer (FK ON DELETE SET NULL). */
export function useDeleteClaudeCredential(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credentialId: string) =>
      webJson<{ ok: true }>(`/orgs/${orgId}/claude-credentials/${credentialId}`, {
        method: "DELETE",
      }),
    onSuccess: (_result, credentialId) => {
      removeUsageCache(usageCacheKey(qk.orgUsage(orgId)));
      removeUsageCache(usageCacheKey(qk.orgCredentialUsage(orgId, credentialId)));
      void qc.invalidateQueries({ queryKey: qk.orgClaudeCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      void qc.invalidateQueries({ queryKey: qk.session() });
      void qc.invalidateQueries({ queryKey: qk.orgUsage(orgId) });
    },
  });
}

// ── Codex account (owner-only — the decoded account email of the pasted auth.json) ─────────────────
// The Codex secret's account email is decoded on-read from the stored auth.json's `id_token` (display-only,
// no signature check) and is Administer-tier info, so it lives on its own OWNER-gated endpoint rather than
// the member-visible presence flags. `present` mirrors `hasCodex`; `accountEmail` is omitted for an
// API-key-only auth.json (no `id_token` to decode).

/** The owner-only `GET /credentials/codex` response — presence + the decoded account email, when present. */
export interface CodexAccount {
  present: boolean;
  accountEmail?: string;
}

/**
 * Owner-only: the connected Codex subscription's account email (decoded from the stored auth.json). Pass
 * `enabled: false` for non-owners to skip a guaranteed 403 — the display is separately gated on ownership.
 */
export function useCodexAccount(orgId: string, enabled = true) {
  return useQuery({
    queryKey: qk.orgCodexAccount(orgId),
    queryFn: () => webJson<CodexAccount>(`/orgs/${orgId}/credentials/codex`),
    enabled: Boolean(orgId) && enabled,
    staleTime: 15_000,
  });
}

/**
 * An org's Claude subscription usage snapshot (the composer's usage ring). Push-driven: fresh snapshots
 * arrive over the repo `/events` SSE (`type:'usage'` frame → `setQueryData`), so there's no client poll.
 * We keep an initial fetch on mount plus TanStack's default focus refetch as a backstop (the SSE bus is
 * single-process, so cross-instance changes settle on mount/focus/switch); a short `staleTime` lets those
 * refetch. The unofficial usage endpoint stays aggressively rate-limited and backend-throttled — do NOT
 * re-add a `refetchInterval`. Always returns 200 (never throws on a degraded snapshot); `ok:false` just
 * means "unknown right now".
 */
export function useOrgUsage(orgId: string) {
  const cacheKey = useMemo(() => usageCacheKey(qk.orgUsage(orgId)), [orgId]);
  const seed = useMemo(() => readUsageCache<WireOrgUsage>(cacheKey), [cacheKey]);
  const query = useQuery({
    queryKey: qk.orgUsage(orgId),
    queryFn: () => webJson<WireOrgUsage>(`/orgs/${orgId}/usage`),
    enabled: Boolean(orgId),
    staleTime: 30_000,
    // Seed the last-known value from localStorage so the ring paints instantly on mount; its known age still
    // lets `staleTime` fire a refetch when it's stale.
    initialData: seed?.data,
    initialDataUpdatedAt: seed?.at,
    // Re-enable focus refetch (the app disables it globally) so the documented
    // backstop is real: with the poll dropped, this is how a client on an instance
    // that missed the single-process SSE push recovers a stale ring.
    refetchOnWindowFocus: true,
  });
  usePersistUsage(cacheKey, query.data, query.dataUpdatedAt);
  return query;
}

/**
 * One PERSONAL credential's own Claude subscription usage (the ring on its Settings card). Live-fetched
 * per-credential (never the org snapshot), server-cached ~3 min; same best-effort/degraded contract as
 * {@link useOrgUsage} — always 200, `ok:false` just means "unknown right now". Do NOT call for setup tokens.
 */
export function useCredentialUsage(orgId: string, credentialId: string, enabled = true) {
  const cacheKey = useMemo(
    () => usageCacheKey(qk.orgCredentialUsage(orgId, credentialId)),
    [orgId, credentialId],
  );
  const seed = useMemo(() => readUsageCache<WireOrgUsage>(cacheKey), [cacheKey]);
  const query = useQuery({
    queryKey: qk.orgCredentialUsage(orgId, credentialId),
    queryFn: () => webJson<WireOrgUsage>(`/orgs/${orgId}/claude-credentials/${credentialId}/usage`),
    enabled: Boolean(orgId) && Boolean(credentialId) && enabled,
    staleTime: 180_000,
    refetchInterval: 180_000,
    initialData: seed?.data,
    initialDataUpdatedAt: seed?.at,
  });
  usePersistUsage(cacheKey, query.data, query.dataUpdatedAt);
  return query;
}

/**
 * Body for `PUT /web/orgs/:orgId/credentials` — every field optional; only sent ones are written.
 * Two distinct purposes: the `*ApiKey` keys power LangChain prompts + embeddings; the subscription
 * secrets (`claudeOauthToken`, `codexAuthSecret`) authenticate the coding-engine SDK harness.
 */
export interface SaveCredentialsBody {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
  /** Claude subscription OAuth token for the coding engine (`sk-ant-oat…`). */
  claudeOauthToken?: string;
  /** Codex subscription secret for the (optional) Codex coding engine. */
  codexAuthSecret?: string;
}

/** The server's per-key validation result (Anthropic key is probed on write). */
export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface SaveCredentialsResult {
  ok: boolean;
  validation: { llmKey?: ValidationResult };
}

/** Owner-only credential write. Invalidates the presence query so the saved-key pills refresh. */
export function useSaveCredentials(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveCredentialsBody) =>
      webJson<SaveCredentialsResult>(`/orgs/${orgId}/credentials`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      // A new Codex paste changes the decoded account email — refresh the owner-only Codex query too.
      void qc.invalidateQueries({ queryKey: qk.orgCodexAccount(orgId) });
      // Credential changes can flip an org `onboarding` → `active`; refresh the session orgs too.
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}

// ── Workspace profile (Atlas-managed per-repo provisioning: mounts, setup script, preview recipe,
// secret-file refs, acknowledged manifests) ──────────────────────────────────────────────────────────
// One repo-scoped surface over the same `WorkspaceConfigStore`/`WorkspaceSecretFileStore` rows the
// onboarding brain's `write_workspace_config` tool writes through — a console edit and a brain call
// converge on the same DB rows. GET is member-readable; every write is owner-only server-side. Secret
// file VALUES are never re-exposed — only refs (path + label); the underlying files endpoint is shared
// with the (retired) workspace-secrets tab, so writes still go through `/orgs/:orgId/workspace-secrets/files`
// with `repoId` in the body.

export interface WorkspaceProfileMount {
  path: string;
  mode: "per-thread" | "shared-ro" | "shared-rw";
}
export interface WorkspaceProfileSecretFileRef {
  path: string;
  label?: string | null;
}
export interface WorkspaceProfileView {
  mounts: WorkspaceProfileMount[];
  setupScript: string | null;
  previewRecipe: string | null;
  secretFiles: WorkspaceProfileSecretFileRef[];
  seenManifests: string[] | null;
}

/** One repo's Atlas-managed provisioning (GET /web/orgs/:orgId/repos/:repoId/workspace-profile). Member-readable. */
export function useWorkspaceProfile(orgId: string, repoId: string) {
  return useQuery({
    queryKey: qk.orgWorkspaceProfile(orgId, repoId),
    queryFn: () =>
      webJson<WorkspaceProfileView>(
        `/orgs/${orgId}/repos/${repoId}/workspace-profile`,
      ),
    enabled: Boolean(orgId && repoId),
    staleTime: 15_000,
  });
}

/** Owner-only: idempotent upsert-by-path of a mount. Server returns `restartsSandbox: true` — the mount SET changed, so in-flight sandboxes recreate on next attach. */
export function useSaveMount(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; mode: string }) =>
      webJson<{ ok: true; restartsSandbox: true }>(
        `/orgs/${orgId}/repos/${repoId}/workspace-profile/mounts`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.orgWorkspaceProfile(orgId, repoId),
      }),
  });
}

/** Owner-only: remove a mount by path. Also restarts sandboxes on next attach. */
export function useDeleteMount(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string }) =>
      webJson<{ ok: true; restartsSandbox: true }>(
        `/orgs/${orgId}/repos/${repoId}/workspace-profile/mounts`,
        { method: "DELETE", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.orgWorkspaceProfile(orgId, repoId),
      }),
  });
}

/** Owner-only: set (or, with `script: null`, clear) the repo's setup script. Runs on every cold sandbox bring-up. */
export function useSaveSetupScript(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { script: string | null }) =>
      webJson<{ ok: true }>(
        `/orgs/${orgId}/repos/${repoId}/workspace-profile/setup-script`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.orgWorkspaceProfile(orgId, repoId),
      }),
  });
}

/** Owner-only: set (or, with `instructions: null`, clear) the repo's preview recipe. */
export function useSavePreviewRecipe(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { instructions: string | null }) =>
      webJson<{ ok: true }>(
        `/orgs/${orgId}/repos/${repoId}/workspace-profile/preview-recipe`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.orgWorkspaceProfile(orgId, repoId),
      }),
  });
}

/** Owner-only: create/replace a repo's secret file at a destination path. Reuses the existing (unretired) secret-files endpoint — repoId goes in the body, not the path. */
export function useSaveRepoSecretFile(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; value: string; label?: string }) =>
      webJson<{ ok: boolean }>(`/orgs/${orgId}/workspace-secrets/files`, {
        method: "PUT",
        body: JSON.stringify({ ...body, repoId }),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.orgWorkspaceProfile(orgId, repoId),
      }),
  });
}

/** Owner-only: delete a repo's secret file. */
export function useDeleteRepoSecretFile(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string }) =>
      webJson<{ ok: boolean }>(`/orgs/${orgId}/workspace-secrets/files`, {
        method: "DELETE",
        body: JSON.stringify({ ...body, repoId }),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.orgWorkspaceProfile(orgId, repoId),
      }),
  });
}

// ── MCP servers (user-defined tool servers, in System / Org / Repo tiers) ──────────────────────────
// GET returns the read-only System tier plus the org + repo user servers, with EVERY secret header/env
// value redacted (secret slots come back `null` in `config`, and are listed in `secretKeys`). Writes
// (PUT/DELETE/validate) are owner-only server-side. A secret field follows the credentials UX: presence
// is shown, and re-entering a value changes it — submitting a secret entry with an EMPTY value preserves
// the stored one. The URL scope is `'org'` (org-wide) or a repo id (repo-scoped).

export type McpTransport = "http" | "sse" | "stdio";
export type McpSurface = "brain" | "build" | "review";
export type McpAuthKind = "static" | "oauth";
export type McpOAuthTokenAuthMethod =
  | "none"
  | "client_secret_post"
  | "client_secret_basic";

/** Non-secret OAuth knobs (only meaningful when `authKind='oauth'`). Tokens themselves are never exposed. */
export interface McpOAuthConfig {
  scope?: string;
  tokenAuthMethod?: McpOAuthTokenAuthMethod;
}

/** A built-in server, shown read-only so operators know what the agent already has. */
export interface SystemMcpServer {
  name: string;
  description: string;
  transport: McpTransport;
  tools: string[];
  /** Whether this built-in is actually live right now, for this org + deployment. */
  active: boolean;
  /** When inactive, what to configure to turn it on. */
  inactiveReason?: string;
}

/** The non-secret, fully displayable config; secret header/env values appear as `null`. */
export interface StoredMcpConfig {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string | null>;
  env?: Record<string, string | null>;
  oauth?: McpOAuthConfig;
}

/** A user server as returned to the client — NEVER any secret value. */
export interface McpServer {
  /** `'org'` for an org-wide server, otherwise the repo id. */
  scope: "org" | string;
  name: string;
  transport: McpTransport;
  config: StoredMcpConfig;
  /** `header:<name>` / `env:<name>` keys whose value is a stored secret. */
  secretKeys: string[];
  surfaces: McpSurface[];
  enabled: boolean;
  discoveredTools: string[] | null;
  lastValidatedAt: string | null;
  validationError: string | null;
  /** `'static'` (header/env secrets) or `'oauth'` (interactive OAuth 2.1). */
  authKind: McpAuthKind;
  /** OAuth only: consent has completed (a token bundle exists). Never the token itself. */
  oauthConnected: boolean;
  /** OAuth only: the last resolve/refresh failed — the operator must reconnect. */
  needsReauth: boolean;
}

export interface McpServersView {
  system: SystemMcpServer[];
  servers: McpServer[];
}

/** One header/env entry sent on write. `secret:true` + empty `value` preserves the stored secret. */
export interface McpHeaderInput {
  name: string;
  value: string;
  secret?: boolean;
}

/** Body for `PUT /web/orgs/:orgId/mcp-servers/:scope/:name` — replaces the server row. */
export interface SaveMcpServerBody {
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: McpHeaderInput[];
  env?: McpHeaderInput[];
  surfaces?: McpSurface[];
  enabled?: boolean;
  authKind?: McpAuthKind;
  oauth?: McpOAuthConfig;
}

export interface McpValidateResult {
  ok: boolean;
  discoveredTools?: string[];
  error?: string;
}

export function useMcpServers(orgId: string) {
  return useQuery({
    queryKey: qk.orgMcpServers(orgId),
    queryFn: () => webJson<McpServersView>(`/orgs/${orgId}/mcp-servers`),
    enabled: Boolean(orgId),
    staleTime: 15_000,
  });
}

/** Owner-only: create/replace a server at a scope (`'org'` or a repo id). */
export function useSaveMcpServer(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scope,
      name,
      body,
    }: {
      scope: string;
      name: string;
      body: SaveMcpServerBody;
    }) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/mcp-servers/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgMcpServers(orgId) }),
  });
}

/** Owner-only: delete a server at a scope. */
export function useDeleteMcpServer(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/mcp-servers/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgMcpServers(orgId) }),
  });
}

/** Owner-only: best-effort probe (remote handshake / stdio structural). Persists the discovered tools. */
export function useValidateMcpServer(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }) =>
      webJson<McpValidateResult>(
        `/orgs/${orgId}/mcp-servers/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/validate`,
        { method: "POST" },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgMcpServers(orgId) }),
  });
}

/**
 * Owner-only: begin interactive OAuth consent for an `authKind='oauth'` server. Returns the provider authorize
 * URL; the caller opens it (a popup) and the provider redirects the browser back to the backend callback, which
 * completes the token exchange. The console refetches the server list when the popup posts back / closes.
 */
export function useStartMcpOAuth(orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }) =>
      webJson<{ authorizeUrl: string }>(
        `/orgs/${orgId}/mcp-servers/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/oauth/start`,
        { method: "POST" },
      ),
  });
}

/**
 * Owner-only: drive the interactive OAuth consent popup for an already-registered `authKind='oauth'`
 * server — centralizes the popup open, the callback's postMessage/focus-close handling, and the server-list
 * refetch, so the settings form and the job-workspace proposal card share one implementation. Does not
 * persist the server itself; callers pass a scope+name that's already been saved.
 */
export function useMcpOAuthConnect(orgId: string) {
  const qc = useQueryClient();
  const startOAuth = useStartMcpOAuth(orgId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    if (!busy) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; ok?: boolean } | null;
      if (!data || data.type !== "atlas-mcp-oauth") return;
      setBusy(false);
      setResult(
        data.ok
          ? { ok: true, text: "Connected." }
          : { ok: false, text: "Authorization did not complete." },
      );
      void qc.invalidateQueries({ queryKey: qk.orgMcpServers(orgId) });
    };
    const onFocus = () => {
      if (popupRef.current && popupRef.current.closed) {
        popupRef.current = null;
        setBusy(false);
      }
      void qc.invalidateQueries({ queryKey: qk.orgMcpServers(orgId) });
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
    };
  }, [busy, orgId, qc]);

  const connect = useCallback(
    async ({ scope, name }: { scope: string; name: string }) => {
      setResult(null);
      try {
        const { authorizeUrl } = await startOAuth.mutateAsync({ scope, name });
        setBusy(true);
        const popup = window.open(authorizeUrl, "atlas-mcp-oauth", "width=520,height=680");
        popupRef.current = popup;
        if (!popup) {
          setBusy(false);
          setResult({ ok: false, text: "Popup blocked — allow popups and retry." });
        }
      } catch (e) {
        setBusy(false);
        setResult({ ok: false, text: (e as Error)?.message || "Could not start OAuth." });
      }
    },
    [startOAuth],
  );

  return { connect, busy, result, reset: () => setResult(null) };
}

// ── Org CRUD (create / rename / delete) ──────────────────────────────────────────────────────────
// The org rail + settings read orgs off the SESSION (`GET /auth/session`), so every write invalidates
// `qk.session()`. The cross-org inbox (`/web/threads`, `useAllJobs`) embeds `org.name` per row and
// feeds the sidebar / workspace / command palette / rail badges, so rename + delete also invalidate it.

/** Create an org — the caller becomes its owner; it starts in `onboarding`.
 *  WIRED (RTK): POST /orgs. Vars stay `string` (name) for existing callers; the mutation
 *  invalidates SESSION so `useCurrentUser`'s org list refetches. */
export function useCreateOrg(): MutationResultLike<OrgSummary, string> {
  const [trigger, state] = useCreateOrgMutation();
  return adaptMutation([(name: string) => trigger({ name }), state]);
}

/** Owner-only rename / automation-defaults update. WIRED (RTK): PATCH /orgs/:orgId.
 *  Takes the shared `UpdateOrgDto` (name + the three auto-* booleans) directly. */
export function useUpdateOrg(orgId: string): MutationResultLike<OrgSummary, UpdateOrgDto> {
  const [trigger, state] = useUpdateOrgMutation();
  return adaptMutation([(body: UpdateOrgDto) => trigger({ orgId, body }), state]);
}

/** Owner-only delete — tears down the org's repos, threads, and live agent sessions. Irreversible.
 *  WIRED (RTK): DELETE /orgs/:orgId. */
export function useDeleteOrg(orgId: string): MutationResultLike<{ ok: boolean }, void> {
  const [trigger, state] = useDeleteOrgMutation();
  return adaptMutation([() => trigger(orgId), state]) as unknown as MutationResultLike<
    { ok: boolean },
    void
  >;
}

// ── Repos (the settings Repos tab — connect / re-validate / edit / disconnect) ─────────────────────
// The list itself (`GET /web/orgs/:orgId/repos`) is read via `useOrgRepos` (`./job-queries`), which
// also feeds the create-job picker; it returns the enriched `RepoView` (with `threadCount` +
// `accessCheckedAt`). These mutations all invalidate `qk.orgRepos(orgId)` so that enriched list refetches
// — their own responses (`ConnectedRepo`) deliberately do NOT carry those derived fields. Connect /
// disconnect / re-validate can also flip the org `onboarding`↔`active`, so they invalidate `qk.session()`.

/** The repo as connect / re-validate / update return it — note: no `threadCount` / `accessCheckedAt`. */
export interface ConnectedRepo {
  id: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  /** Per-repo feature-branch prefix override; null uses the built-in default. */
  branchPrefix: string | null;
  /** Repo-level default GitHub merge method used by auto-merge and the manual Merge PR button. */
  defaultAutoMergeMethod: AutoMergeMethod;
  /** Repo-level default: delete the head branch after a successful merge. */
  defaultAutoMergeDeleteBranch: boolean;
  accessOk: boolean;
  /** Present on a failed access probe (connect / re-validate); the real GitHub reason. */
  reason?: string;
}

/** Body for `POST /web/orgs/:orgId/repos` — connect a GitHub repo (owner only). */
export interface ConnectRepoBody {
  repoUrl: string;
  displayName?: string;
  baseBranch?: string;
}

/**
 * Connect a GitHub repo to the org. The repo list (`useOrgRepos`) is a realtime feed, so the new repo
 * appears via a WAL `add` delta — this mutation only invalidates `SESSION` (connect can flip the org
 * status). GitHub access probing is deferred to the GitHub module; until it lands the repo saves as
 * `accessOk:false`.
 */
export function useConnectRepo(orgId: string): MutationResultLike<ConnectedRepo, ConnectRepoBody> {
  const [trigger, state] = useConnectRepoMutation();
  return adaptMutation<ConnectedRepo, ConnectRepoBody>([
    (body) => trigger({ orgId, body }),
    state,
  ]);
}

/** Re-probe a repo's GitHub access with the org's current token (owner only). */
export function useRevalidateRepo(orgId: string): MutationResultLike<ConnectedRepo, string> {
  const [trigger, state] = useRevalidateRepoMutation();
  return adaptMutation<ConnectedRepo, string>([(repoId) => trigger({ orgId, repoId }), state]);
}

/**
 * (Re-)run the Atlas onboarding thread for a repo. Deferred to the threads slice — onboarding spawns a
 * thread, which doesn't exist yet — so this is a loud stub until then.
 */
export function useReonboardRepo(_orgId: string): MutationResultLike<{ jobId: string }, string> {
  return stubMutation<{ jobId: string }, string>("re-onboard repo");
}

/** Body for `PATCH /web/orgs/:orgId/repos/:repoId` — metadata only (no GitHub call). */
export interface UpdateRepoBody {
  name?: string;
  defaultBranch?: string;
  /** Per-repo feature-branch prefix; empty string clears it back to the neutral default. */
  branchPrefix?: string;
  /** Repo-level default GitHub merge method for auto-merge / manual Merge PR. */
  defaultAutoMergeMethod?: AutoMergeMethod;
  /** Repo-level default: delete the head branch after a successful merge. */
  defaultAutoMergeDeleteBranch?: boolean;
}

/** Update a repo's display name / base branch (owner only). Realtime reflects the change as a delta. */
export function useUpdateRepo(
  orgId: string,
): MutationResultLike<ConnectedRepo, { repoId: string; body: UpdateRepoBody }> {
  const [trigger, state] = useUpdateRepoMutation();
  return adaptMutation<ConnectedRepo, { repoId: string; body: UpdateRepoBody }>([
    ({ repoId, body }) => trigger({ orgId, repoId, body }),
    state,
  ]);
}

/**
 * Disconnect a repo (owner only). CASCADE-deletes the repo's threads server-side, returning how many
 * were torn down — the UI warns first. The repo list is realtime (its removal arrives as a WAL `remove`
 * delta); this only invalidates `SESSION` (disconnect can flip the org `active`↔`onboarding`).
 */
export function useDisconnectRepo(
  orgId: string,
): MutationResultLike<{ ok: boolean; threadsDeleted: number }, string> {
  const [trigger, state] = useDisconnectRepoMutation();
  return adaptMutation<{ ok: boolean; threadsDeleted: number }, string>([
    (repoId) => trigger({ orgId, repoId }),
    state,
  ]);
}

// ── Convention profiles (reusable house-style bundles, opt-in per repo) ─────────────────────────────
// An org defines named house-style profiles (folder conventions, stack idioms, a shared-contract layout);
// a repo opts in by pointing `convention_profile_slug` at one, and its `body` is injected into every
// build-facing prompt for that repo. GET is any-member; writes (PUT/DELETE profile, PUT repo attach) are
// owner-only server-side. No secrets — the body is plain text. Mirrors the onboarding brain's owner-gated
// proposal flow, exposed here for manual management.

export interface ConventionProfile {
  slug: string;
  name: string;
  body: string;
  /** Natural-language "what stack this matches" — used by the onboarding brain to auto-propose it. */
  detectHint: string | null;
}

export interface ConventionProfilesView {
  profiles: ConventionProfile[];
}

/** Body for `PUT /web/orgs/:orgId/convention-profiles/:slug` — create or replace a profile. */
export interface SaveConventionProfileBody {
  name: string;
  body: string;
  detectHint?: string;
}

/** Every house-style profile for the org (with body) — the settings editor's data. */
export function useConventionProfiles(orgId: string) {
  return useQuery({
    queryKey: qk.orgConventionProfiles(orgId),
    queryFn: () =>
      webJson<ConventionProfilesView>(`/orgs/${orgId}/convention-profiles`),
    enabled: Boolean(orgId),
    staleTime: 15_000,
  });
}

/** Owner-only: create/replace a profile by slug. */
export function useSaveConventionProfile(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, body }: { slug: string; body: SaveConventionProfileBody }) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/convention-profiles/${encodeURIComponent(slug)}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgConventionProfiles(orgId) }),
  });
}

/** Owner-only: delete a profile. Repos still pointing at it fall back to "no house style". */
export function useDeleteConventionProfile(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/convention-profiles/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgConventionProfiles(orgId) }),
  });
}

/** The slug currently attached to a repo (or null) — the repo-attach control's initial state. */
export function useRepoConventionProfile(orgId: string, repoId: string) {
  return useQuery({
    queryKey: qk.repoConventionProfile(orgId, repoId),
    queryFn: () =>
      webJson<{ slug: string | null }>(
        `/orgs/${orgId}/convention-profiles/repo/${repoId}`,
      ),
    enabled: Boolean(orgId && repoId),
    staleTime: 15_000,
  });
}

/** Owner-only: attach a profile to a repo, or clear it with `slug: null`. */
export function useAttachConventionProfile(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, slug }: { repoId: string; slug: string | null }) =>
      webJson<{ ok: boolean; slug: string | null }>(
        `/orgs/${orgId}/convention-profiles/repo/${repoId}`,
        { method: "PUT", body: JSON.stringify({ slug }) },
      ),
    onSuccess: (_res, { repoId }) =>
      void qc.invalidateQueries({
        queryKey: qk.repoConventionProfile(orgId, repoId),
      }),
  });
}

// ── Skills (directory-based skill bundles: git-installed or custom-authored) ───────────────────────
// Registry metadata only — the real `SKILL.md` + support files live on the host store. Two writable
// scopes (org-wide `'org'` + per-repo). GET (list + the file/content viewer) is any-member; every
// mutation (install/set/update/fork/delete) is owner-only server-side. Mirrors the MCP hooks above.

export type SkillProvenance = "git" | "custom" | "managed";
export type SkillUpdatePolicy = "pinned" | "track-ref" | "manual";

/** A built-in (Atlas-managed) skill, shown read-only — the skills counterpart of `SystemMcpServer`. Not a
 *  `workspace_skills` row (no `scope`/`enabled`/etc.) — it's code-defined, always on. Two flavors: STATIC
 *  (no `git`, committed to `backend/skills-managed/`) or GIT-SOURCED (`git` present — synced from an
 *  upstream repo by `ManagedSkillSyncService`; `synced` says whether that sync has landed yet). */
export interface SystemSkill {
  name: string;
  description: string;
  surfaces: McpSurface[];
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
  git?: { url: string; subpath: string; ref: string };
  synced?: boolean;
}

/** A skill as returned to the client — no secrets exist on a skill, so this is the full row. */
export interface Skill {
  /** `'org'` for an org-wide skill, otherwise the repo id. */
  scope: "org" | string;
  name: string;
  description: string;
  provenance: SkillProvenance;
  sourceUrl: string | null;
  sourceRef: string | null;
  sourceSubpath: string | null;
  installedSha: string | null;
  updatePolicy: SkillUpdatePolicy | null;
  forkedFrom: string | null;
  surfaces: McpSurface[];
  reviewForTypes: string[];
  reviewForGlobs: string[];
  enabled: boolean;
  /** True for a `pinned`/`manual` git skill whose remote has moved past `installedSha`. */
  updateAvailable: boolean;
}

/** The `snake_case` shape the backend actually returns (`SkillView`) — mapped to `Skill` on read. */
interface SkillWire {
  scope: string;
  name: string;
  description: string;
  provenance: SkillProvenance;
  source_url: string | null;
  source_ref: string | null;
  source_subpath: string | null;
  installed_sha: string | null;
  update_policy: SkillUpdatePolicy | null;
  forked_from: string | null;
  surfaces: McpSurface[];
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
  enabled: boolean;
  update_available: boolean;
}

function fromWire(s: SkillWire): Skill {
  return {
    scope: s.scope,
    name: s.name,
    description: s.description,
    provenance: s.provenance,
    sourceUrl: s.source_url,
    sourceRef: s.source_ref,
    sourceSubpath: s.source_subpath,
    installedSha: s.installed_sha,
    updatePolicy: s.update_policy,
    forkedFrom: s.forked_from,
    surfaces: s.surfaces,
    reviewForTypes: s.reviewForTypes ?? [],
    reviewForGlobs: s.reviewForGlobs ?? [],
    enabled: s.enabled,
    updateAvailable: s.update_available,
  };
}

/** The `GET /skills` response: the read-only System tiers (Atlas-managed + Claude Code bundled) alongside
 *  this org's writable Organization/Repository skills. */
export interface SkillsView {
  system: SystemSkill[];
  bundled: string[];
  skills: Skill[];
}

/** Every skill for the org — the System tiers plus org-wide + every repo scope. */
export function useSkills(orgId: string) {
  return useQuery({
    queryKey: qk.orgSkills(orgId),
    queryFn: async () => {
      const { system, bundled, skills } = await webJson<{
        system: SystemSkill[];
        bundled: string[];
        skills: SkillWire[];
      }>(`/orgs/${orgId}/skills`);
      return { system, bundled, skills: skills.map(fromWire) } satisfies SkillsView;
    },
    enabled: Boolean(orgId),
    staleTime: 15_000,
  });
}

/** Body for `POST /web/orgs/:orgId/skills/install` — install (or re-install) from a git repo, or expand
 *  every skill a marketplace manifest lists. */
export interface InstallSkillBody {
  scope: string;
  sourceUrl: string;
  ref?: string;
  subpath?: string;
  updatePolicy?: SkillUpdatePolicy;
  surfaces?: McpSurface[];
}

/** Owner-only: install from GitHub. */
export function useInstallSkill(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InstallSkillBody) =>
      webJson<{ skills: SkillWire[] }>(`/orgs/${orgId}/skills/install`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.orgSkills(orgId) }),
  });
}

/** Body for `PUT /web/orgs/:orgId/skills/:scope/:name` — create/replace a skill's registry row, and (when
 *  `body` is set) its `SKILL.md` content — a custom skill's create/edit path. */
export interface SaveSkillBody {
  description: string;
  provenance?: SkillProvenance;
  surfaces?: McpSurface[];
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
  enabled?: boolean;
  updatePolicy?: SkillUpdatePolicy;
  /** `SKILL.md` body (frontmatter-stripped) — custom skills only. */
  body?: string;
}

/** Owner-only: create a custom skill, or edit one (registry fields, and — for a custom skill — its
 *  `SKILL.md` body). */
export function useSaveSkill(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, name, body }: { scope: string; name: string; body: SaveSkillBody }) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            description: body.description,
            provenance: body.provenance,
            surfaces: body.surfaces,
            reviewForTypes: body.reviewForTypes,
            reviewForGlobs: body.reviewForGlobs,
            enabled: body.enabled,
            update_policy: body.updatePolicy,
            body: body.body,
          }),
        },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.orgSkills(orgId) }),
  });
}

/** Owner-only: apply-now — re-vendor a `git` skill from its recorded source, regardless of `updatePolicy`. */
export function useUpdateSkill(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/update`,
        { method: "POST" },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.orgSkills(orgId) }),
  });
}

/** Owner-only: fork a `git` skill to a fresh, freely-editable `custom` copy in the same scope. */
export function useForkSkill(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }) =>
      webJson<{ skill: SkillWire }>(
        `/orgs/${orgId}/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/fork`,
        { method: "POST" },
      ).then((res) => fromWire(res.skill)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.orgSkills(orgId) }),
  });
}

/** Owner-only: delete a skill (registry row + its on-disk dir). */
export function useDeleteSkill(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.orgSkills(orgId) }),
  });
}

/** A skill's read-only file tree + `SKILL.md` content — the console viewer's data (any member; not cached
 *  under `qk.orgSkills` since it's fetched on demand per open viewer). */
export function useSkillFiles(orgId: string, scope: string, name: string, enabled: boolean) {
  return useQuery({
    queryKey: [...qk.orgSkills(orgId), "files", scope, name] as const,
    queryFn: () =>
      webJson<{ files: string[]; skillMd: string | null }>(
        `/orgs/${orgId}/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/files`,
      ),
    enabled: Boolean(orgId && scope && name) && enabled,
    staleTime: 15_000,
  });
}
