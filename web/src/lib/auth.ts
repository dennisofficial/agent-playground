import { Auth } from '@workspace/auth';
import type { IAdminUserResponse } from '@workspace/shared';
import { env } from './env';

/**
 * Singleton Auth instance for the admin portal.
 *
 * Cookie-mode (no tokenPersistence) — the backend sets httpOnly access_token +
 * refresh_token cookies; JS never touches the token values.  attachInterceptors
 * wires the 401→refresh→retry cycle onto the shared axios instance.
 */
const auth = new Auth<IAdminUserResponse>();

auth.configure({
  apiBaseUrl: env.NEXT_PUBLIC_BACKEND_URL,
  authBasePath: '/auth',
  sessionToAuthState: (s) => ({
    authenticated: true,
    authProviderId: s.id,
    profileId: s.id,
  }),
});

// Attach refresh interceptor to the shared httpClient so 401 responses
// automatically trigger a cookie-refresh and retry.
auth.attachInterceptors(auth.httpClient);

export { auth };
