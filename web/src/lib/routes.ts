/**
 * Typed route helpers (house pattern from rs-crm/cubix `SITE_MAP`, hand-rolled here since
 * `@workspace/site-map` isn't vendored in this repo).
 *
 * A thread is addressed by its real `org/repo/thread` coordinate — every thread API call is org+repo
 * scoped, and the cross-org inbox (`/web/threads`) carries all three ids per row. The triple is encoded
 * into the single `[threadKey]` path segment so the route shape (`/workspace/:threadKey`) is stable.
 */

/** The ids needed to address one thread against the org → repo → thread API. */
export interface ThreadRefParts {
  orgId: string;
  repoId: string;
  threadId: string;
}

// `~` is never present in a UUID (org/thread ids) or a repo slug, so it's a safe separator that keeps the
// key a single path segment — unlike `/`, which `encodeURIComponent` turns into `%2F` (encoded slashes are
// normalized inconsistently by servers/Next and can break single-segment matching).
const REF_SEP = '~';

/** Encode `{ orgId, repoId, threadId }` into one URL path segment. */
export function encodeThreadRef(ref: ThreadRefParts): string {
  return [ref.orgId, ref.repoId, ref.threadId].map(encodeURIComponent).join(REF_SEP);
}

/** Decode a `[threadKey]` segment back to its ids; `null` if it isn't a well-formed triple. */
export function decodeThreadRef(threadKey: string): ThreadRefParts | null {
  const parts = threadKey.split(REF_SEP);
  if (parts.length !== 3) return null;
  try {
    const [orgId, repoId, threadId] = parts.map(decodeURIComponent);
    if (!orgId || !repoId || !threadId) return null;
    return { orgId, repoId, threadId };
  } catch {
    return null;
  }
}

/** Full href to a thread workspace. */
export function threadHref(ref: ThreadRefParts): string {
  return `/workspace/${encodeThreadRef(ref)}`;
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
  thread: (threadKey: string) => `/workspace/${threadKey}`,
  newThread: () => '/new',
  /** Org settings (General / Credentials / Members / Repos). `section` deep-links a tab. */
  orgSettings: (orgId: string, section?: SettingsSection) =>
    section ? `/orgs/${orgId}/settings?section=${section}` : `/orgs/${orgId}/settings`,
} as const;

export type SettingsSection = 'general' | 'credentials' | 'members' | 'repos';

/** Only honor a same-origin relative `?next=` target (no open-redirect). */
export function safeNext(next: string | null | undefined, fallback = ROUTES.workspace()): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('://')) {
    return next;
  }
  return fallback;
}
