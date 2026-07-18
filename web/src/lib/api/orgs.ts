'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { notImplemented, stubMutation, stubQuery, type MutationResultLike } from './_stub';
import { useMutation } from './_tanstack-shim';
import type { WireOrgUsage } from './types';

/**
 * STUBBED for the Atlas rebuild: the old `/orgs/:orgId/...` backend hasn't been rebuilt yet, so every
 * hook here is an inert placeholder. Reads render empty (`stubQuery`); writes throw "Not Implemented"
 * on invoke (`notImplemented`) so an unwired action can never look like it succeeded. Types + doc
 * comments are kept verbatim as the contract for whichever slice eventually replaces this file.
 */

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
  mode: 'pat' | 'app';
  /** The connected installation id (plaintext, non-secret); null when not connected. */
  installationId: string | null;
  /** The installation's GitHub account login (display) — null when not connected. */
  account: string | null;
}

export function useGithubAppStatus(_orgId: string) {
  return stubQuery<GithubAppStatus>();
}

/**
 * Owner-only: mint the org's single-use GitHub App install URL. Does not persist anything — the install
 * lands on GitHub's redirect back to the settings page, which the backend callback verifies + stores.
 */
export function useGithubAppInstallUrl(_orgId: string) {
  return useMutation({
    mutationFn: (): Promise<{ url: string }> => notImplemented('useGithubAppInstallUrl'),
  });
}

/**
 * Owner-only: switch the resolved GitHub credential between `pat` and `app`. `app` requires a connected
 * installation server-side. Invalidates presence + status (the mode drives which credential authenticates)
 * and the session (mode can flip the onboarding checklist).
 */
export function useSetGithubAuthMode(_orgId: string) {
  return useMutation({
    mutationFn: (mode: 'pat' | 'app'): Promise<{ ok: true; mode: 'pat' | 'app' }> =>
      notImplemented('useSetGithubAuthMode'),
  });
}

/**
 * Owner-only: disconnect the org's GitHub App installation. Invalidates status + presence/session (the
 * resolved credential and onboarding checklist can shift when the App goes away).
 */
export function useDisconnectGithubApp(_orgId: string) {
  return useMutation({
    mutationFn: (): Promise<{ ok: true }> => notImplemented('useDisconnectGithubApp'),
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
export function useOrgUsage(_orgId: string) {
  return stubQuery<WireOrgUsage>();
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
  mode: 'per-thread' | 'shared-ro' | 'shared-rw';
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
export function useWorkspaceProfile(_orgId: string, _repoId: string) {
  return stubQuery<WorkspaceProfileView>();
}

/** Owner-only: idempotent upsert-by-path of a mount. Server returns `restartsSandbox: true` — the mount SET changed, so in-flight sandboxes recreate on next attach. */
export function useSaveMount(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: {
      path: string;
      mode: string;
    }): Promise<{ ok: true; restartsSandbox: true }> => notImplemented('useSaveMount'),
  });
}

/** Owner-only: remove a mount by path. Also restarts sandboxes on next attach. */
export function useDeleteMount(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { path: string }): Promise<{ ok: true; restartsSandbox: true }> =>
      notImplemented('useDeleteMount'),
  });
}

/** Owner-only: set (or, with `script: null`, clear) the repo's setup script. Runs on every cold sandbox bring-up. */
export function useSaveSetupScript(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { script: string | null }): Promise<{ ok: true }> =>
      notImplemented('useSaveSetupScript'),
  });
}

/** Owner-only: set (or, with `instructions: null`, clear) the repo's preview recipe. */
export function useSavePreviewRecipe(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { instructions: string | null }): Promise<{ ok: true }> =>
      notImplemented('useSavePreviewRecipe'),
  });
}

/** Owner-only: create/replace a repo's secret file at a destination path. Reuses the existing (unretired) secret-files endpoint — repoId goes in the body, not the path. */
export function useSaveRepoSecretFile(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { path: string; value: string; label?: string }): Promise<{ ok: boolean }> =>
      notImplemented('useSaveRepoSecretFile'),
  });
}

/** Owner-only: delete a repo's secret file. */
export function useDeleteRepoSecretFile(_orgId: string, _repoId: string) {
  return useMutation({
    mutationFn: (body: { path: string }): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteRepoSecretFile'),
  });
}

// ── MCP servers (user-defined tool servers, in System / Org / Repo tiers) ──────────────────────────
// GET returns the read-only System tier plus the org + repo user servers, with EVERY secret header/env
// value redacted (secret slots come back `null` in `config`, and are listed in `secretKeys`). Writes
// (PUT/DELETE/validate) are owner-only server-side. A secret field follows the credentials UX: presence
// is shown, and re-entering a value changes it — submitting a secret entry with an EMPTY value preserves
// the stored one. The URL scope is `'org'` (org-wide) or a repo id.

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpSurface = 'brain' | 'build' | 'review';
export type McpAuthKind = 'static' | 'oauth';
export type McpOAuthTokenAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

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
  scope: 'org' | string;
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

export function useMcpServers(_orgId: string) {
  return stubQuery<McpServersView>();
}

/** Owner-only: create/replace a server at a scope (`'org'` or a repo id). */
export function useSaveMcpServer(_orgId: string) {
  return useMutation({
    mutationFn: ({
      scope,
      name,
      body,
    }: {
      scope: string;
      name: string;
      body: SaveMcpServerBody;
    }): Promise<{ ok: boolean }> => notImplemented('useSaveMcpServer'),
  });
}

/** Owner-only: delete a server at a scope. */
export function useDeleteMcpServer(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteMcpServer'),
  });
}

/** Owner-only: best-effort probe (remote handshake / stdio structural). Persists the discovered tools. */
export function useValidateMcpServer(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<McpValidateResult> =>
      notImplemented('useValidateMcpServer'),
  });
}

/**
 * Owner-only: begin interactive OAuth consent for an `authKind='oauth'` server. Returns the provider authorize
 * URL; the caller opens it (a popup) and the provider redirects the browser back to the backend callback, which
 * completes the token exchange. The console refetches the server list when the popup posts back / closes.
 */
export function useStartMcpOAuth(_orgId: string) {
  return useMutation({
    mutationFn: ({
      scope,
      name,
    }: {
      scope: string;
      name: string;
    }): Promise<{ authorizeUrl: string }> => notImplemented('useStartMcpOAuth'),
  });
}

/**
 * Owner-only: drive the interactive OAuth consent popup for an already-registered `authKind='oauth'`
 * server — centralizes the popup open, the callback's postMessage/focus-close handling, and the server-list
 * refetch, so the settings form and the job-workspace proposal card share one implementation. Does not
 * persist the server itself; callers pass a scope+name that's already been saved.
 */
export function useMcpOAuthConnect(orgId: string) {
  const startOAuth = useStartMcpOAuth(orgId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    if (!busy) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; ok?: boolean } | null;
      if (!data || data.type !== 'atlas-mcp-oauth') return;
      setBusy(false);
      setResult(
        data.ok
          ? { ok: true, text: 'Connected.' }
          : { ok: false, text: 'Authorization did not complete.' },
      );
    };
    const onFocus = () => {
      if (popupRef.current && popupRef.current.closed) {
        popupRef.current = null;
        setBusy(false);
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
    };
  }, [busy]);

  const connect = useCallback(
    async ({ scope, name }: { scope: string; name: string }) => {
      setResult(null);
      try {
        const { authorizeUrl } = await startOAuth.mutateAsync({ scope, name });
        setBusy(true);
        const popup = window.open(authorizeUrl, 'atlas-mcp-oauth', 'width=520,height=680');
        popupRef.current = popup;
        if (!popup) {
          setBusy(false);
          setResult({
            ok: false,
            text: 'Popup blocked — allow popups and retry.',
          });
        }
      } catch (e) {
        setBusy(false);
        setResult({
          ok: false,
          text: (e as Error)?.message || 'Could not start OAuth.',
        });
      }
    },
    [startOAuth],
  );

  return { connect, busy, result, reset: () => setResult(null) };
}

// ── Org CRUD + repo mutations — now consumed RTK-native straight from the slices ────────────────────
// `@/redux/query/api/org.api` (useCreateOrg/useUpdateOrg/useDeleteOrgMutation) and
// `@/redux/query/api/repo.api` (useConnect/useRevalidate/useUpdate/useDisconnectRepoMutation) own these.
// The repo request/response shapes live in `@workspace/shared` (ConnectRepoDto / UpdateRepoDto /
// ConnectedRepo / DisconnectRepoResult). Only the re-onboard stub remains here (no threads slice yet).

/**
 * (Re-)run the Atlas onboarding thread for a repo. Deferred to the threads slice — onboarding spawns a
 * thread, which doesn't exist yet — so this is a loud stub until then.
 */
export function useReonboardRepo(_orgId: string): MutationResultLike<{ jobId: string }, string> {
  return stubMutation<{ jobId: string }, string>('re-onboard repo');
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
export function useConventionProfiles(_orgId: string) {
  return stubQuery<ConventionProfilesView>();
}

/** Owner-only: create/replace a profile by slug. */
export function useSaveConventionProfile(_orgId: string) {
  return useMutation({
    mutationFn: ({
      slug,
      body,
    }: {
      slug: string;
      body: SaveConventionProfileBody;
    }): Promise<{ ok: boolean }> => notImplemented('useSaveConventionProfile'),
  });
}

/** Owner-only: delete a profile. Repos still pointing at it fall back to "no house style". */
export function useDeleteConventionProfile(_orgId: string) {
  return useMutation({
    mutationFn: (slug: string): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteConventionProfile'),
  });
}

/** The slug currently attached to a repo (or null) — the repo-attach control's initial state. */
export function useRepoConventionProfile(_orgId: string, _repoId: string) {
  return stubQuery<{ slug: string | null }>();
}

/** Owner-only: attach a profile to a repo, or clear it with `slug: null`. */
export function useAttachConventionProfile(_orgId: string) {
  return useMutation({
    mutationFn: ({
      repoId,
      slug,
    }: {
      repoId: string;
      slug: string | null;
    }): Promise<{ ok: boolean; slug: string | null }> =>
      notImplemented('useAttachConventionProfile'),
  });
}

// ── Skills (directory-based skill bundles: git-installed or custom-authored) ───────────────────────
// Registry metadata only — the real `SKILL.md` + support files live on the host store. Two writable
// scopes (org-wide `'org'` + per-repo). GET (list + the file/content viewer) is any-member; every
// mutation (install/set/update/fork/delete) is owner-only server-side. Mirrors the MCP hooks above.

export type SkillProvenance = 'git' | 'custom' | 'managed';
export type SkillUpdatePolicy = 'pinned' | 'track-ref' | 'manual';

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
  scope: 'org' | string;
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

/** The `GET /skills` response: the read-only System tiers (Atlas-managed + Claude Code bundled) alongside
 *  this org's writable Organization/Repository skills. */
export interface SkillsView {
  system: SystemSkill[];
  bundled: string[];
  skills: Skill[];
}

/** Every skill for the org — the System tiers plus org-wide + every repo scope. */
export function useSkills(_orgId: string) {
  return stubQuery<SkillsView>();
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
export function useInstallSkill(_orgId: string) {
  return useMutation({
    mutationFn: (body: InstallSkillBody): Promise<{ skills: SkillWire[] }> =>
      notImplemented('useInstallSkill'),
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
export function useSaveSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({
      scope,
      name,
      body,
    }: {
      scope: string;
      name: string;
      body: SaveSkillBody;
    }): Promise<{ ok: boolean }> => notImplemented('useSaveSkill'),
  });
}

/** Owner-only: apply-now — re-vendor a `git` skill from its recorded source, regardless of `updatePolicy`. */
export function useUpdateSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<{ ok: boolean }> =>
      notImplemented('useUpdateSkill'),
  });
}

/** Owner-only: fork a `git` skill to a fresh, freely-editable `custom` copy in the same scope. */
export function useForkSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<Skill> =>
      notImplemented('useForkSkill'),
  });
}

/** Owner-only: delete a skill (registry row + its on-disk dir). */
export function useDeleteSkill(_orgId: string) {
  return useMutation({
    mutationFn: ({ scope, name }: { scope: string; name: string }): Promise<{ ok: boolean }> =>
      notImplemented('useDeleteSkill'),
  });
}

/** A skill's read-only file tree + `SKILL.md` content — the console viewer's data (any member; not cached
 *  under `qk.orgSkills` since it's fetched on demand per open viewer). */
export function useSkillFiles(_orgId: string, _scope: string, _name: string, _enabled: boolean) {
  return stubQuery<{ files: string[]; skillMd: string | null }>();
}
