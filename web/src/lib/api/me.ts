'use client';

import { useQuery } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { qk } from './query-keys';

/** The authenticated operator, from `GET /auth/session` (bare session — `{ id, email }`). */
export interface CurrentUser {
  id: string;
  email: string;
}

async function fetchCurrentUser(): Promise<CurrentUser> {
  // Direct, credentialed call to the Atlas app (the session cookie authorizes it). This is separate
  // from the `@workspace/auth` client's internal init call, which only keeps `AuthState` (no email).
  const res = await fetch(`${env.NEXT_PUBLIC_ATLAS_HTTP_URL}/auth/session`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`session ${res.status}`);
  return (await res.json()) as CurrentUser;
}

/**
 * The current operator's identity for the account menu. Mounts only inside the authenticated shell, so
 * the session cookie is present; a 401 (e.g. just after sign-out) leaves `data` undefined and callers
 * fall back gracefully.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: qk.currentUser(),
    queryFn: fetchCurrentUser,
    staleTime: 60_000,
    retry: false,
  });
}
