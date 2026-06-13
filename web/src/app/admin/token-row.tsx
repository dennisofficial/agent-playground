'use client';

import { TokenRow as BaseTokenRow } from '@/app/(private)/admin/_components/token-row';
import type { GithubTokenMeta } from '@/lib/admin-api';

/**
 * Thin adapter over the shared TokenRow that omits the `onSuccess` callback.
 * Used by the server-rendered /admin page; mutations still work client-side
 * (the page will reload via a full navigation after the action completes).
 */
export function TokenRow({ teamId, token }: { teamId: string; token: GithubTokenMeta }) {
  return <BaseTokenRow teamId={teamId} token={token} onSuccess={() => {}} />;
}
