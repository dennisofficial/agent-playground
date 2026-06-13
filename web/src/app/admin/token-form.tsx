'use client';

import { TokenForm as BaseTokenForm } from '@/app/(private)/admin/_components/token-form';

/**
 * Thin adapter over the shared TokenForm that omits the `onSuccess` callback.
 * Used by the server-rendered /admin page.
 */
export function TokenForm({ teamId }: { teamId: string }) {
  return <BaseTokenForm teamId={teamId} onSuccess={() => {}} />;
}
