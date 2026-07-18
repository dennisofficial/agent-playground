'use client';

import { GoogleG } from '@/components/ui/brand';
import { Spinner } from '@/components/ui/spinner';
import { auth } from '@/lib/auth';
import { useState } from 'react';

/**
 * Full-width "Continue/Sign up with Google" button. Calls `auth.signInWithGoogle()`; on success the
 * PublicGuard redirects. Surface bg + `--border-2`, hover → `--surface-2`.
 */
export function GoogleButton({
  label,
  onError,
}: {
  label: string;
  onError?: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);

  async function handle() {
    setLoading(true);
    onError?.('');
    try {
      await auth.signInWithGoogle();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Google sign-in failed.');
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={loading}
      className="flex h-11 w-full items-center justify-center gap-2.5 rounded-md border bg-surface text-[13px] font-medium text-text transition hover:bg-surface-2 disabled:opacity-60"
      style={{ borderColor: 'var(--border-2)' }}
    >
      {loading ? (
        <>
          <Spinner className="h-4 w-4" />
          Connecting to Google…
        </>
      ) : (
        <>
          <GoogleG />
          {label}
        </>
      )}
    </button>
  );
}
