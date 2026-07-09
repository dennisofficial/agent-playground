"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { env } from "@/lib/env";
import type { OrgSummary } from "./me";
import { fetchWithRefresh } from "./refresh";
import { qk } from "./query-keys";

/**
 * Org-scoped reads + the credentials write for the settings page. All hit the Atlas app directly with the
 * session cookie; `/web/orgs/:orgId/*` is membership-gated server-side (403 for non-members), writes
 * (credentials PUT) are owner-only. Secrets are never returned — credentials GET is presence flags only.
 */

const BASE = `${env.NEXT_PUBLIC_HTTP_URL}/web`;

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

export function useOrgMembers(orgId: string) {
  return useQuery({
    queryKey: qk.orgMembers(orgId),
    queryFn: () => webJson<Member[]>(`/orgs/${orgId}/members`),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
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
      // Credential changes can flip an org `onboarding` → `active`; refresh the session orgs too.
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}

// ── Worktree secret files (per-repo encrypted files rendered into a thread's sandbox) ──────────────
// GET returns file refs (repo + path + label) only, never values. Writes (PUT/DELETE /files) are
// owner-only server-side. One row IS the value + the authority + the render instruction: a file renders
// only when an owner-created (repo, path) row exists (worktree config — mounts — is a separate DB record
// and never carries secrets; see docs/adr/0003-worktree-config-db-not-git.md).

export interface WorktreeSecretFile {
  repoId: string;
  path: string;
  label?: string | null;
}
export interface WorktreeSecretsView {
  files: WorktreeSecretFile[];
}

export function useWorktreeSecrets(orgId: string) {
  return useQuery({
    queryKey: qk.orgWorktreeSecrets(orgId),
    queryFn: () =>
      webJson<WorktreeSecretsView>(`/orgs/${orgId}/worktree-secrets`),
    enabled: Boolean(orgId),
    staleTime: 15_000,
  });
}

/** Owner-only: create/replace a repo's secret file at a destination path. */
export function useSaveWorktreeSecretFile(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      repoId: string;
      path: string;
      value: string;
      label?: string;
    }) =>
      webJson<{ ok: boolean }>(`/orgs/${orgId}/worktree-secrets/files`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgWorktreeSecrets(orgId) }),
  });
}

/** Owner-only: delete a repo's secret file. */
export function useDeleteWorktreeSecretFile(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { repoId: string; path: string }) =>
      webJson<{ ok: boolean }>(`/orgs/${orgId}/worktree-secrets/files`, {
        method: "DELETE",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgWorktreeSecrets(orgId) }),
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

// ── Org CRUD (create / rename / delete) ──────────────────────────────────────────────────────────
// The org rail + settings read orgs off the SESSION (`GET /auth/session`), so every write invalidates
// `qk.session()`. The cross-org inbox (`/web/threads`, `useAllJobs`) embeds `org.name` per row and
// feeds the sidebar / workspace / command palette / rail badges, so rename + delete also invalidate it.

/** Create an org — the caller becomes its owner; it starts in `onboarding`. */
export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      webJson<OrgSummary>(`/orgs`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}

/** Body for `PATCH /web/orgs/:orgId` — rename and/or re-slug (owner only). */
export interface UpdateOrgBody {
  name?: string;
  slug?: string;
}

/** Owner-only rename / re-slug. */
export function useUpdateOrg(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateOrgBody) =>
      webJson<OrgSummary>(`/orgs/${orgId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.session() });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Owner-only delete — tears down the org's repos, threads, and live agent sessions. Irreversible. */
export function useDeleteOrg(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      webJson<{ ok: boolean }>(`/orgs/${orgId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.session() });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
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

/** Connect a GitHub repo to the org. */
export function useConnectRepo(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConnectRepoBody) =>
      webJson<ConnectedRepo>(`/orgs/${orgId}/repos`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgRepos(orgId) });
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}

/** Re-probe a repo's GitHub access with the org's current token (owner only). */
export function useRevalidateRepo(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) =>
      webJson<ConnectedRepo>(`/orgs/${orgId}/repos/${repoId}/revalidate`, {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgRepos(orgId) });
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}

/**
 * (Re-)run the Atlas onboarding thread for a repo (owner only). Spawns a fresh onboarding thread even if
 * the repo was onboarded before; returns its id so the caller can deep-link into it. Invalidates the repo
 * list so the onboarding state (`onboardingThreadId`) refreshes.
 */
export function useReonboardRepo(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) =>
      webJson<{ jobId: string }>(`/orgs/${orgId}/repos/${repoId}/onboard`, {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgRepos(orgId) });
    },
  });
}

/** Body for `PATCH /web/orgs/:orgId/repos/:repoId` — metadata only (no GitHub call). */
export interface UpdateRepoBody {
  name?: string;
  defaultBranch?: string;
}

/** Update a repo's display name / base branch (owner only). */
export function useUpdateRepo(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, body }: { repoId: string; body: UpdateRepoBody }) =>
      webJson<ConnectedRepo>(`/orgs/${orgId}/repos/${repoId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgRepos(orgId) });
    },
  });
}

/**
 * Disconnect a repo (owner only). CASCADE-deletes the repo's threads (and their sandboxes / feature
 * branches / messages) server-side, returning how many were torn down — the UI warns first. Invalidates
 * the repo list, the cross-org thread inbox (threads were deleted → `useAllJobs` feeds the sidebar /
 * rail badges / command palette), and the session (disconnect can flip the org `active`↔`onboarding`).
 */
export function useDisconnectRepo(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) =>
      webJson<{ ok: boolean; threadsDeleted: number }>(
        `/orgs/${orgId}/repos/${repoId}`,
        {
          method: "DELETE",
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgRepos(orgId) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
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
