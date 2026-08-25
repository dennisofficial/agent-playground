import { auth } from '@/lib/auth';
import { env } from '@/lib/env';
import { connectivity } from './connectivity';

/**
 * Single-flight session refresh for the NATIVE fetch (`/web/*`, `/auth/session`) and SSE paths. Unlike
 * the `@dltech/jwt-auth` axios client, these have no built-in 401→refresh interceptor, so the 15-min
 * access cookie expiring would otherwise silently break the console (REST 401s; an SSE 401 is FATAL and
 * EventSource never reconnects) until a full page reload.
 *
 * Concurrent 401s (a `/web/*` call and the SSE stream racing) share ONE `POST /auth/refresh` round-trip.
 * A definitive 401 (the refresh token is also gone) signs the operator out exactly once so the
 * PrivateGuard redirects to `/auth/login`; transient failures (offline / 5xx) just return `false` so the
 * caller can surface an error and a later attempt can retry.
 *
 * A 401 is only treated as definitive after a CONFIRMING second attempt: `/auth/refresh` was observed
 * 401'ing transiently around a backend watch-respawn (07-01) with cookies that a plain reload proved
 * were still valid — and signing out on that one blip clears the cookies (the signOut fires
 * `POST /auth/logout`), turning a transient glitch into a real logout.
 */
const CONFIRM_401_DELAY_MS = 1_500;

let inflight: Promise<boolean> | null = null;

type RefreshOutcome = 'ok' | 'unauthorized' | 'transient';

async function postRefresh(): Promise<RefreshOutcome> {
  try {
    const res = await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (res.ok) return 'ok';
    return res.status === 401 ? 'unauthorized' : 'transient';
  } catch {
    return 'transient'; // network / server down — keep the session; let the caller retry later
  }
}

export function refreshSession(): Promise<boolean> {
  inflight ??= (async (): Promise<boolean> => {
    try {
      const first = await postRefresh();
      if (first !== 'unauthorized') return first === 'ok';
      await new Promise((r) => setTimeout(r, CONFIRM_401_DELAY_MS));
      const second = await postRefresh();
      if (second === 'ok') return true;
      // Two 401s in a row → the session is truly gone → flip AuthState → redirect to login.
      if (second === 'unauthorized') auth.signOut();
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * `fetch` with one transparent retry after a successful session refresh on 401. Always sends credentials
 * (the httpOnly session cookie). Returns the final `Response` — the retried one when a refresh succeeded,
 * otherwise the original 401.
 */
export async function fetchWithRefresh(input: string, init?: RequestInit): Promise<Response> {
  const opts: RequestInit = { ...init, credentials: 'include' };
  let res: Response;
  try {
    res = await fetch(input, opts);
  } catch (err) {
    connectivity.reportUnreachable(); // network-level failure — the backend didn't answer
    throw err;
  }
  connectivity.reportReachable(); // the server responded (any status) → backend is up
  if (res.status !== 401) return res;
  const refreshed = await refreshSession();
  return refreshed ? fetch(input, opts) : res;
}
