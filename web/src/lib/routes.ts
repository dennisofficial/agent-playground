/**
 * Typed route helpers (house pattern from rs-crm/cubix `SITE_MAP`, hand-rolled here since
 * `@workspace/site-map` isn't vendored in this repo).
 *
 * A job is addressed by its bare id — the URL is `/jobs/:jobId` (which redirects to the job's
 * `focusedThreadId`) and `/jobs/:jobId/:threadId` for a specific lane. Org/repo are NOT in the URL: the
 * backend enforces access via RLS, and the client resolves them from the job payload / inbox cache when
 * needed. `jobId` and `threadId` are globally-unique uuids, so no encoding/triple-key is required.
 */

/** The ids needed to address one thread against the (internal) org → repo → thread hooks. Org/repo are
 *  resolved from the job payload — they no longer live in the URL. */
export interface ThreadRefParts {
  orgId: string;
  repoId: string;
  jobId: string;
}

/** Href to a job — routes to its focused thread. Optionally deep-link a specific `threadId`. */
export function threadHref(jobId: string, threadId?: string): string {
  return threadId ? `/jobs/${jobId}/${threadId}` : `/jobs/${jobId}`;
}

export const ROUTES = {
  home: () => '/',
  auth: {
    login: (next?: string) =>
      next ? `/auth/login?next=${encodeURIComponent(next)}` : '/auth/login',
    signup: () => '/auth/signup',
    forgot: () => '/auth/forgot',
    signedOut: () => '/auth/signed-out',
  },
  workspace: () => '/workspace',
  job: (jobId: string, threadId?: string) =>
    threadId ? `/jobs/${jobId}/${threadId}` : `/jobs/${jobId}`,
  /** Create-thread route. Optionally pre-select an org (and repo) — used by the sidebar's per-org/repo ＋. */
  newThread: (opts?: { orgId?: string; repoId?: string }) => {
    const p = new URLSearchParams();
    if (opts?.orgId) p.set('org', opts.orgId);
    if (opts?.repoId) p.set('repo', opts.repoId);
    const qs = p.toString();
    return qs ? `/new?${qs}` : '/new';
  },
  /** Org settings (General / Credentials / Members / Repos). Each section is its own route segment. */
  orgSettings: (orgId: string, section?: SettingsSection) =>
    section ? `/orgs/${orgId}/settings/${section}` : `/orgs/${orgId}/settings`,
} as const;

export type SettingsSection =
  | 'general'
  | 'automation'
  | 'credentials'
  | 'workspace-profile'
  | 'mcp-servers'
  | 'convention-profiles'
  | 'skills'
  | 'members'
  | 'repos';

/** Only honor a same-origin relative `?next=` target (no open-redirect). */
export function safeNext(next: string | null | undefined, fallback = ROUTES.workspace()): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('://')) {
    return next;
  }
  return fallback;
}
