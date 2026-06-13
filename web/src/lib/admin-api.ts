import { auth } from './auth';
import type { FactView, FactListResponse, TenantView, Tier } from '@workspace/shared';

// Re-export shared types so consumers can import them from this module.
export type { FactView, FactListResponse, TenantView, Tier };

/**
 * Client-side admin API.  Uses the @workspace/auth axios instance:
 *   - withCredentials: true  (httpOnly access_token cookie sent automatically)
 *   - 401 → token refresh → retry  (via attachInterceptors in auth.ts)
 *
 * All project and token endpoints are tenant-scoped: /tenants/:teamId/projects and
 * /tenants/:teamId/tokens. Every function accepts teamId as its first argument;
 * callers read it from useSearchParams() and pass it in.
 *
 * Type mirrors of backend/src/harness/projects/project.types.ts — two small interfaces;
 * mirroring beats coupling the web build to backend sources (keep in sync by hand).
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

// ─── helpers ──────────────────────────────────────────────────────────────────

function tenantPath(teamId: string, path: string): string {
  return `/tenants/${encodeURIComponent(teamId)}${path}`;
}

/** Extract a human-readable message from an Axios-shaped error without using `any`. */
function toApiError(error: unknown): Error {
  if (error !== null && typeof error === 'object' && 'response' in error) {
    const axErr = error as { response?: { data?: { message?: unknown } } };
    const msg = axErr.response?.data?.message;
    const text = Array.isArray(msg)
      ? msg.map(String).join('; ')
      : typeof msg === 'string'
        ? msg
        : null;
    if (text) return new Error(text);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

async function api<T>(fn: () => Promise<{ data: T }>): Promise<T> {
  try {
    const res = await fn();
    return res.data;
  } catch (error) {
    throw toApiError(error);
  }
}

// ─── projects ─────────────────────────────────────────────────────────────────

export const listProjects = (teamId: string) =>
  api(() => auth.httpClient.get<ProjectRecord[]>(tenantPath(teamId, '/projects')));

export const createProject = (
  teamId: string,
  dto: {
    projectId: string;
    displayName: string;
    gitUrl: string;
    defaultBranch?: string;
    tokenName?: string;
  },
) => api(() => auth.httpClient.post<ProjectRecord>(tenantPath(teamId, '/projects'), dto));

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
  api(() =>
    auth.httpClient.patch<ProjectRecord>(
      tenantPath(teamId, `/projects/${encodeURIComponent(id)}`),
      dto,
    ),
  );

// ─── tokens ───────────────────────────────────────────────────────────────────

export const listTokens = (teamId: string) =>
  api(() => auth.httpClient.get<GithubTokenMeta[]>(tenantPath(teamId, '/tokens')));

export const putToken = (teamId: string, dto: { name: string; token: string; default?: boolean }) =>
  api(() => auth.httpClient.post<GithubTokenMeta>(tenantPath(teamId, '/tokens'), dto));

export const setDefaultToken = (teamId: string, name: string) =>
  api(() =>
    auth.httpClient.put<{ ok: boolean }>(
      tenantPath(teamId, `/tokens/${encodeURIComponent(name)}/default`),
    ),
  );

export const deleteToken = (teamId: string, name: string) =>
  api(() =>
    auth.httpClient.delete<{ ok: boolean }>(
      tenantPath(teamId, `/tokens/${encodeURIComponent(name)}`),
    ),
  );

// ── Memory Viewer API ────────────────────────────────────────────────────────────────────────────

/** All registered workspaces, sorted by display name. Powers the workspace picker. */
export const listTenants = () =>
  api(() => auth.httpClient.get<TenantView[]>('/tenants'));

/** Filtered, paginated list of facts for a tenant. */
export function listFacts(teamId: string, query: FactQuery = {}): Promise<FactListResponse> {
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
  return api(() =>
    auth.httpClient.get<FactListResponse>(
      `/tenants/${encodeURIComponent(teamId)}/memory/facts${qs ? `?${qs}` : ''}`,
    ),
  );
}

/** Single fact by numeric row id (includes soft-deleted). Returns null-equivalent on 404. */
export const getFact = (teamId: string, id: number) =>
  api(() =>
    auth.httpClient.get<FactView>(
      `/tenants/${encodeURIComponent(teamId)}/memory/facts/${encodeURIComponent(String(id))}`,
    ),
  );

const ALL_FACTS_PAGE_SIZE = 200;

/**
 * Load every fact for a tenant via paginated client-side requests.
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
