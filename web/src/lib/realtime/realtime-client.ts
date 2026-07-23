import { env } from '@/lib/env';
import { RealtimeClient } from '@workspace/pg-realtime/client';

/**
 * App-singleton `RealtimeClient` — ONE multiplexed socket.io connection for every
 * `job`-cluster realtime query (see `redux/query/api/jobs.api.ts`). Auth is the httpOnly
 * `access_token` cookie the backend socket gateway reads off the handshake, so no `auth`
 * callback is needed here — just `withCredentials` so the cookie rides along.
 *
 * Lazily constructed on first access and guarded to the browser: Next.js can import this
 * module during SSR/RSC rendering, where `io()` would try (and fail) to open a socket.
 */
let client: RealtimeClient | undefined;

export function getRealtimeClient(): RealtimeClient {
  if (typeof window === 'undefined') {
    throw new Error('getRealtimeClient() is browser-only (SSR/RSC has no socket to open)');
  }
  if (!client) {
    client = new RealtimeClient({
      url: env.NEXT_PUBLIC_BACKEND_URL,
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
  }
  return client;
}
