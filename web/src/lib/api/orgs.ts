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

// ── Worktree secrets (named secret files rendered into a thread's sandbox) ─────────────────────────
// GET returns names + grants only (never values). Writes (secret PUT/DELETE, grant PUT/DELETE) are
// owner-only server-side. A secret is inert until an owner GRANTS it for a specific repo + path — the
// grant alone is the authority (worktree config — mounts — is a separate DB record and never
// carries secrets; see docs/adr/0003-worktree-config-db-not-git.md).

export interface WorktreeSecretGrant {
  repoId: string;
  name: string;
  path: string;
}
export interface WorktreeSecretsView {
  names: string[];
  grants: WorktreeSecretGrant[];
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

/** Owner-only: create/replace a named secret value. */
export function useSaveWorktreeSecret(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/worktree-secrets/secrets/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          body: JSON.stringify({ value }),
        },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgWorktreeSecrets(orgId) }),
  });
}

/** Owner-only: delete a named secret (and its grants). */
export function useDeleteWorktreeSecret(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      webJson<{ ok: boolean }>(
        `/orgs/${orgId}/worktree-secrets/secrets/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
        },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgWorktreeSecrets(orgId) }),
  });
}

/** Owner-only: grant a secret to a repo + path (the security control). */
export function useGrantWorktreeSecret(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorktreeSecretGrant) =>
      webJson<{ ok: boolean }>(`/orgs/${orgId}/worktree-secrets/grants`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgWorktreeSecrets(orgId) }),
  });
}

/** Owner-only: revoke a grant. */
export function useRevokeWorktreeSecret(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorktreeSecretGrant) =>
      webJson<{ ok: boolean }>(`/orgs/${orgId}/worktree-secrets/grants`, {
        method: "DELETE",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.orgWorktreeSecrets(orgId) }),
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
