import { auth } from './auth';
import { env } from './env';

/**
 * Client-side admin API.  Uses the @workspace/auth axios instance:
 *   - withCredentials: true  (httpOnly access_token cookie sent automatically)
 *   - 401 → token refresh → retry  (via attachInterceptors in auth.ts)
 *
 * Routes are tenant-scoped: /tenants/:teamId/…
 * Set NEXT_PUBLIC_TEAM_ID in web/.env.personal to your Slack workspace team_id.
 *
 * Function signatures are identical to the previous server-side version so
 * call-sites in components require no changes beyond the onSuccess wiring.
 */

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

function tenantPath(path: string): string {
  return `/tenants/${env.NEXT_PUBLIC_TEAM_ID}${path}`;
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

export const listProjects = () =>
  api(() => auth.httpClient.get<ProjectRecord[]>(tenantPath('/projects')));

export const createProject = (dto: {
  projectId: string;
  displayName: string;
  gitUrl: string;
  defaultBranch?: string;
  tokenName?: string;
}) => api(() => auth.httpClient.post<ProjectRecord>(tenantPath('/projects'), dto));

export const updateProject = (
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
      tenantPath(`/projects/${encodeURIComponent(id)}`),
      dto,
    ),
  );

// ─── tokens ───────────────────────────────────────────────────────────────────

export const listTokens = () =>
  api(() => auth.httpClient.get<GithubTokenMeta[]>(tenantPath('/tokens')));

export const putToken = (dto: { name: string; token: string; default?: boolean }) =>
  api(() => auth.httpClient.post<GithubTokenMeta>(tenantPath('/tokens'), dto));

export const setDefaultToken = (name: string) =>
  api(() =>
    auth.httpClient.put<{ ok: boolean }>(
      tenantPath(`/tokens/${encodeURIComponent(name)}/default`),
    ),
  );

export const deleteToken = (name: string) =>
  api(() =>
    auth.httpClient.delete<{ ok: boolean }>(
      tenantPath(`/tokens/${encodeURIComponent(name)}`),
    ),
  );
