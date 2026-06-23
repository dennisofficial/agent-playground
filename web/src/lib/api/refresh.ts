import { auth } from '@/lib/auth';
import { env } from '@/lib/env';
import { connectivity } from './connectivity';

/**
 * Single-flight session refresh for the NATIVE fetch (`/web/*`, `/auth/session`) and SSE paths. Unlike
 * the `@workspace/auth` axios client, these have no built-in 401→refresh interceptor, so the 15-min
 * access cookie expiring would otherwise silently break the console (REST 401s; an SSE 401 is FATAL and
 * EventSource never reconnects) until a full page reload.
 *
 * Concurrent 401s (a `/web/*` call and the SSE stream racing) share ONE `POST /auth/refresh` round-trip.
 * A definitive 401 (the refresh token is also gone) signs the operator out exactly once so the
 * PrivateGuard redirects to `/auth/login`; transient failures (offline / 5xx) just return `false` so the
 * caller can surface an error and a later attempt can retry.
 */
let inflight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  inflight ??= (async (): Promise<boolean> => {
    try {
      const res = await fetch(`${env.NEXT_PUBLIC_ATLAS_HTTP_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) return true;
      if (res.status === 401) auth.signOut(); // session truly gone → flip AuthState → redirect to login
      return false;
    } catch {
      return false; // transient (network / server down) — keep the session; let the caller retry later
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
