import { auth } from './auth';

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
