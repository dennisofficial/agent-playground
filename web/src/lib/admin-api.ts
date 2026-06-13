import { auth } from './auth';
import { env } from './env';
import type { FactView, FactListResponse, TenantView, Tier } from '@workspace/shared';

// Re-export shared types so consumers can import them from this module.
export type { FactView, FactListResponse, TenantView, Tier };

/**
 * Server-side client for the backend admin API. The bearer lives in server env and every call
 * happens on the Next server (Server Components for reads, Server Actions for mutations) — the
 * browser never talks to the backend or sees the token.
 *
 * All project and token endpoints are tenant-scoped: /tenants/:teamId/projects and
 * /tenants/:teamId/tokens. Every function accepts teamId as its first argument.
 *
 * Type mirrors of backend/src/harness/projects/project.types.ts — two small interfaces; mirroring
 * beats coupling the web build to backend sources (keep in sync by hand).
 */

/** Query params for `listFacts` / `listAllFacts`. All optional. */
export interface FactQuery {
  tier?: Tier;
  projectId?: string;
  botId?: string;
  assertedBy?: string;
  q?: string;
  includeDeleted?: boolean;
  includeGlobal?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'updated' | 'created';
}

export interface ProjectRecord {
  projectId: string;
  displayName: string;
  gitUrl: string;
  defaultBranch: string;
  tokenName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GithubTokenMeta {
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = env.ADMIN_API_TOKEN;
  if (!token) {
    throw new Error(
      'ADMIN_API_TOKEN is not set for the web app — add it to web/.env.personal (same value as the backend).',
    );
  }
  const res = await fetch(`${env.BACKEND_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    throw new Error(message || `Backend admin API answered ${res.status}.`);
  }
  return (await res.json()) as T;
}

/** Builds the tenant-scoped base path for all project/token routes. */
const tenantBase = (teamId: string) => `/tenants/${encodeURIComponent(teamId)}`;

export const listProjects = (teamId: string) =>
  adminFetch<ProjectRecord[]>(`${tenantBase(teamId)}/projects`);

export const createProject = (
  teamId: string,
  dto: {
    projectId: string;
    displayName: string;
    gitUrl: string;
    defaultBranch?: string;
    tokenName?: string;
  },
) =>
  adminFetch<ProjectRecord>(`${tenantBase(teamId)}/projects`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });

export const updateProject = (
  teamId: string,
  id: string,
  dto: Partial<{
    displayName: string;
    gitUrl: string;
    defaultBranch: string;
    tokenName: string | null;
  }>,
) =>
  adminFetch<ProjectRecord>(
    `${tenantBase(teamId)}/projects/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(dto) },
  );

export const listTokens = (teamId: string) =>
  adminFetch<GithubTokenMeta[]>(`${tenantBase(teamId)}/tokens`);

export const putToken = (teamId: string, dto: { name: string; token: string; default?: boolean }) =>
  adminFetch<GithubTokenMeta>(`${tenantBase(teamId)}/tokens`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });

export const setDefaultToken = (teamId: string, name: string) =>
  adminFetch<{ ok: boolean }>(
    `${tenantBase(teamId)}/tokens/${encodeURIComponent(name)}/default`,
    { method: 'PUT' },
  );

export const deleteToken = (teamId: string, name: string) =>
  adminFetch<{ ok: boolean }>(
    `${tenantBase(teamId)}/tokens/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );

// ── Memory Viewer API ────────────────────────────────────────────────────────────────────────────

/** All registered workspaces, sorted by display name. Powers the workspace picker. */
export const listTenants = async (): Promise<TenantView[]> => {
  const res = await auth.httpClient.get<TenantView[]>('/tenants');
  return res.data;
};

/** Filtered, paginated list of facts for a tenant. */
export async function listFacts(teamId: string, query: FactQuery = {}): Promise<FactListResponse> {
  const params = new URLSearchParams();
  if (query.tier !== undefined) params.set('tier', query.tier);
  if (query.projectId !== undefined) params.set('projectId', query.projectId);
  if (query.botId !== undefined) params.set('botId', query.botId);
  if (query.assertedBy !== undefined) params.set('assertedBy', query.assertedBy);
  if (query.q !== undefined) params.set('q', query.q);
  if (query.includeDeleted !== undefined)
    params.set('includeDeleted', String(query.includeDeleted));
  if (query.includeGlobal !== undefined)
    params.set('includeGlobal', String(query.includeGlobal));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.sort !== undefined) params.set('sort', query.sort);

  const qs = params.toString();
  const res = await auth.httpClient.get<FactListResponse>(
    `/tenants/${encodeURIComponent(teamId)}/memory/facts${qs ? `?${qs}` : ''}`,
  );
  return res.data;
}

/** Single fact by numeric row id (includes soft-deleted). Returns null-equivalent on 404. */
export const getFact = async (teamId: string, id: number): Promise<FactView> => {
  const res = await auth.httpClient.get<FactView>(
    `/tenants/${encodeURIComponent(teamId)}/memory/facts/${encodeURIComponent(String(id))}`,
  );
  return res.data;
};

const ALL_FACTS_PAGE_SIZE = 200;

/**
 * Load every fact for a tenant in a single server-side call (paginated under the hood).
 * Always fetches with `includeDeleted: true` so the client can compute the forgotten count
 * hint without a second request.
 *
 * A `cap` (default 2000) guards against unexpectedly huge datasets — if truncated, the viewer
 * shows a notice rather than silently losing data.
 */
export async function listAllFacts(
  teamId: string,
  { cap = 2000 }: { cap?: number } = {},
): Promise<{ facts: FactView[]; total: number; truncated: boolean }> {
  const facts: FactView[] = [];
  let offset = 0;
  let total = 0;

  do {
    const page = await listFacts(teamId, {
      includeDeleted: true,
      limit: ALL_FACTS_PAGE_SIZE,
      offset,
    });
    total = page.total;
    facts.push(...page.items);
    offset += page.items.length;
    // Stop when we've loaded everything, got an empty page, or hit the safety cap.
  } while (facts.length < total && facts.length > 0 && facts.length < cap);

  const truncated = facts.length < total;
  return { facts, total, truncated };
}
