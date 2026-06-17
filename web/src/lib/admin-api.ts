import { auth } from './auth';
import type {
  FactListResponse,
  FactQuery,
  FactView,
  GithubTokenMeta,
  ProjectRecord,
  TenantView,
  Tier,
} from '@workspace/shared';

// Re-export shared types so consumers can import them from this module.
export type {
  FactListResponse,
  FactQuery,
  FactView,
  GithubTokenMeta,
  ProjectRecord,
  TenantView,
  Tier,
};

// ── Memory Viewer API ────────────────────────────────────────────────────────────────────────────

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

const ALL_FACTS_PAGE_SIZE = 200;

/**
 * Load every fact for a tenant in a single call (paginated under the hood).
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
