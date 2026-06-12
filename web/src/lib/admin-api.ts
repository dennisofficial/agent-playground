import 'server-only';
import { env } from './env';

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
