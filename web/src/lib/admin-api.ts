import 'server-only';
import { env } from './env';
import type { Tier } from '@/app/admin/memory/tiers';

/**
 * Server-side client for the backend admin API. The bearer lives in server env and every call
 * happens on the Next server (Server Components for reads, Server Actions for mutations) — the
 * browser never talks to the backend or sees the token.
 *
 * Type mirrors of backend/src/harness/projects/project.types.ts — two small interfaces; mirroring
 * beats coupling the web build to backend sources (keep in sync by hand).
 */

// ── Memory Viewer types ──────────────────────────────────────────────────────────────────────────
// TODO: import FactView, FactListResponse, TenantView from @workspace/shared once Alex's migration
// pass lands (see shared/src/dto/index.ts — currently an empty stub).

/** A workspace/team as returned by `GET /tenants`. slug === id (Slack team id). */
export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * One semantic-memory fact as returned by `GET /tenants/:teamId/memory/facts`.
 * Shape confirmed against fact-view.store.ts + e2e tests. Note: `id` is a number (DB row id),
 * `content` is the fact text, and `isGlobal`/`scope`/`assertedBy` are never returned.
 */
export interface FactView {
  id: number;
  content: string;
  tier: Tier;
  /** Bot id parsed from scope; null for team- and project-tier facts. */
  botId: string | null;
  /** Project id parsed from scope; null for non-project facts. */
  projectId: string | null;
  /** Human participant for pair-scope facts; null for non-private facts. */
  humanId: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp when soft-deleted ("forgotten"); null if the fact is active. */
  deletedAt: string | null;
}

/** Paginated fact list response. */
export interface FactsPage {
  items: FactView[];
  total: number;
  limit: number;
  offset: number;
}

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

export const listProjects = () => adminFetch<ProjectRecord[]>('/projects');

export const createProject = (dto: {
  projectId: string;
  displayName: string;
  gitUrl: string;
  defaultBranch?: string;
  tokenName?: string;
}) => adminFetch<ProjectRecord>('/projects', { method: 'POST', body: JSON.stringify(dto) });

export const updateProject = (
  id: string,
  dto: Partial<{
    displayName: string;
    gitUrl: string;
    defaultBranch: string;
    tokenName: string | null;
  }>,
) =>
  adminFetch<ProjectRecord>(`/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(dto),
  });

export const listTokens = () => adminFetch<GithubTokenMeta[]>('/tokens');

export const putToken = (dto: { name: string; token: string; default?: boolean }) =>
  adminFetch<GithubTokenMeta>('/tokens', { method: 'POST', body: JSON.stringify(dto) });

export const setDefaultToken = (name: string) =>
  adminFetch<{ ok: boolean }>(`/tokens/${encodeURIComponent(name)}/default`, { method: 'PUT' });

export const deleteToken = (name: string) =>
  adminFetch<{ ok: boolean }>(`/tokens/${encodeURIComponent(name)}`, { method: 'DELETE' });

// ── Memory Viewer API ────────────────────────────────────────────────────────────────────────────

/** All registered workspaces, sorted by display name. Powers the workspace picker. */
export const listTenants = () => adminFetch<TenantSummary[]>('/tenants');

/** Filtered, paginated list of facts for a tenant. */
export function listFacts(teamId: string, query: FactQuery = {}): Promise<FactsPage> {
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
  return adminFetch<FactsPage>(
    `/tenants/${encodeURIComponent(teamId)}/memory/facts${qs ? `?${qs}` : ''}`,
  );
}

/** Single fact by numeric row id (includes soft-deleted). Returns null-equivalent on 404. */
export const getFact = (teamId: string, id: number) =>
  adminFetch<FactView>(
    `/tenants/${encodeURIComponent(teamId)}/memory/facts/${encodeURIComponent(String(id))}`,
  );

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
