/**
 * Typed route helpers (house pattern from rs-crm/cubix `SITE_MAP`, hand-rolled here since
 * `@workspace/site-map` isn't vendored in this repo).
 *
 * A thread is addressed by an ENCODED SURFACE COORDINATE (`channel::threadTs`), not `atlas_threads.id`
 * — there is no id↔coord endpoint yet (BACKEND_GAPS.md #3). When `/web/threads` lands, swap the
 * encode/decode for the stable id and the route shapes stay identical.
 */

const SEP = '::';

export function encodeThreadKey(channel: string, threadTs: string): string {
  return encodeURIComponent(`${channel}${SEP}${threadTs}`);
}

export function decodeThreadKey(threadKey: string): { channel: string; threadTs: string } {
  const raw = decodeURIComponent(threadKey);
  const idx = raw.indexOf(SEP);
  if (idx === -1) return { channel: raw, threadTs: '' };
  return { channel: raw.slice(0, idx), threadTs: raw.slice(idx + SEP.length) };
}

export type PhaseTab = 'transcript' | 'diff' | 'logs';

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
  threadPlan: (threadKey: string) => `/workspace/${threadKey}/plan`,
  threadDoc: (threadKey: string, docId: string) =>
    `/workspace/${threadKey}/doc/${encodeURIComponent(docId)}`,
  threadPhase: (threadKey: string, phaseId: string, tab: PhaseTab = 'transcript') =>
    `/workspace/${threadKey}/phase/${encodeURIComponent(phaseId)}/${tab}`,
  newThread: () => '/new',
} as const;

/** Only honor a same-origin relative `?next=` target (no open-redirect). */
export function safeNext(next: string | null | undefined, fallback = ROUTES.workspace()): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('://')) {
    return next;
  }
  return fallback;
}
