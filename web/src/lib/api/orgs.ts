'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { fetchWithRefresh } from './refresh';
import { qk } from './query-keys';

/**
 * Org-scoped reads + the credentials write for the settings page. All hit the Atlas app directly with the
 * session cookie; `/web/orgs/:orgId/*` is membership-gated server-side (403 for non-members), writes
 * (credentials PUT) are owner-only. Secrets are never returned — credentials GET is presence flags only.
 */

const BASE = `${env.NEXT_PUBLIC_HTTP_URL}/web`;

async function webJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithRefresh(`${BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
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
  engineAuthSet: boolean;
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

/** Body for `PUT /web/orgs/:orgId/credentials` — every field optional; only sent ones are written. */
export interface SaveCredentialsBody {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
  engineAuthMode?: 'api_key' | 'subscription';
  engineAuthSecret?: string;
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
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orgCredentials(orgId) });
      // Credential changes can flip an org `onboarding` → `active`; refresh the session orgs too.
      void qc.invalidateQueries({ queryKey: qk.session() });
    },
  });
}
