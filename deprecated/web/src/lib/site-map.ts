/**
 * Typed internal routes, built from a route tree via `@dltech/site-map`.
 *
 * A job is addressed by its bare id — the URL is `/jobs/:jobId` (which redirects to the job's
 * `focusedThreadId`) and `/jobs/:jobId/:threadId` for a specific lane. Org/repo are NOT in the URL: the
 * backend enforces access via RLS, and the client resolves them from the job payload / inbox cache when
 * needed. `jobId` and `threadId` are globally-unique uuids, so no encoding/triple-key is required.
 *
 * Param leaves are applied functionally and need a trailing call to yield the string:
 *   SITE_MAP.jobs.job(jobId)()               → '/jobs/:jobId'
 *   SITE_MAP.jobs.job(jobId).thread(t)()     → '/jobs/:jobId/:threadId'
 *   SITE_MAP.orgs.org(orgId).settings.section(s)() → '/orgs/:orgId/settings/:section'
 */
import { createSiteMap } from '@dltech/site-map';

export const SITE_MAP = createSiteMap(({ makeRoute }) => ({
  auth: makeRoute('auth', ({ makeRoute }) => ({
    login: makeRoute<{ next?: string }>('login'),
    signup: makeRoute('signup'),
    forgot: makeRoute('forgot'),
    signedOut: makeRoute('signed-out'),
  })),
  workspace: makeRoute('workspace'),
  jobs: makeRoute('jobs', ({ param }) => ({
    job: param(({ param }) => ({
      thread: param(() => ({})),
    })),
  })),
  /** Create-thread route. Optionally pre-select an org (and repo) — used by the sidebar's per-org/repo ＋. */
  newThread: makeRoute<{ org?: string; repo?: string }>('new'),
  orgs: makeRoute('orgs', ({ param }) => ({
    org: param(({ makeRoute }) => ({
      /** Org settings (General / Credentials / Members / Repos). Each section is its own route segment. */
      settings: makeRoute('settings', ({ param }) => ({
        section: param(() => ({})),
      })),
    })),
  })),
}));

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

export function safeNext(next: string | null | undefined, fallback = SITE_MAP.workspace()): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('://')) {
    return next;
  }
  return fallback;
}
