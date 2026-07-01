/**
 * Typed route helpers (house pattern from rs-crm/cubix `SITE_MAP`, hand-rolled here since
 * `@workspace/site-map` isn't vendored in this repo).
 *
 * A thread is addressed by its real `org/repo/thread` coordinate — every thread API call is org+repo
 * scoped, and the cross-org inbox (`/web/threads`) carries all three ids per row. The triple is encoded
 * into the single `[jobKey]` path segment so the route shape (`/workspace/:jobKey`) is stable.
 */

/** The ids needed to address one thread against the org → repo → thread API. */
export interface ThreadRefParts {
  orgId: string;
  repoId: string;
  jobId: string;
}

// `~` is never present in a UUID (org/thread ids) or a repo slug, so it's a safe separator that keeps the
// key a single path segment — unlike `/`, which `encodeURIComponent` turns into `%2F` (encoded slashes are
// normalized inconsistently by servers/Next and can break single-segment matching).
const REF_SEP = '~';

/** Encode `{ orgId, repoId, jobId }` into one URL path segment. */
export function encodeJobRef(ref: ThreadRefParts): string {
  return [ref.orgId, ref.repoId, ref.jobId].map(encodeURIComponent).join(REF_SEP);
}

/** Decode a `[jobKey]` segment back to its ids; `null` if it isn't a well-formed triple. */
export function decodeJobRef(jobKey: string): ThreadRefParts | null {
  const parts = jobKey.split(REF_SEP);
  if (parts.length !== 3) return null;
  try {
    const [orgId, repoId, jobId] = parts.map(decodeURIComponent);
    if (!orgId || !repoId || !jobId) return null;
    return { orgId, repoId, jobId };
  } catch {
    return null;
  }
}

/** Full href to a thread workspace. */
export function threadHref(ref: ThreadRefParts): string {
  return `/workspace/${encodeJobRef(ref)}`;
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
  thread: (jobKey: string) => `/workspace/${jobKey}`,
  /** Create-thread route. Optionally pre-select an org (and repo) — used by the sidebar's per-org/repo ＋. */
  newThread: (opts?: { orgId?: string; repoId?: string }) => {
    const p = new URLSearchParams();
    if (opts?.orgId) p.set('org', opts.orgId);
    if (opts?.repoId) p.set('repo', opts.repoId);
    const qs = p.toString();
    return qs ? `/new?${qs}` : '/new';
  },
  /** The tickets board/backlog. No args → the picker (first repo); with ids → a specific repo's board. */
  tickets: (orgId?: string, repoId?: string) =>
    orgId && repoId ? `/tickets/${orgId}/${repoId}` : '/tickets',
  /** Org settings (General / Credentials / Members / Repos). `section` deep-links a tab. */
  orgSettings: (orgId: string, section?: SettingsSection) =>
    section ? `/orgs/${orgId}/settings?section=${section}` : `/orgs/${orgId}/settings`,
} as const;

export type SettingsSection = 'general' | 'credentials' | 'worktree-secrets' | 'members' | 'repos';

/** Only honor a same-origin relative `?next=` target (no open-redirect). */
export function safeNext(next: string | null | undefined, fallback = ROUTES.workspace()): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('://')) {
    return next;
  }
  return fallback;
}
