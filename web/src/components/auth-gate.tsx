'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { AuthState } from '@workspace/auth';
import { auth } from '@/lib/auth';

/**
 * Client-side route protection, shared by every authed shell (the admin `(private)` layout and the
 * `(viewer)` plan viewer). Subscribes to auth state via `auth.onAuthStateChanged()` before calling
 * `auth.initialize()`, shows a loading indicator during the session probe, an inline error when the
 * backend is unreachable, and otherwise redirects to `/admin/login` — preserving the current path in
 * a `?next=` param so a deep-linked plan URL survives the round-trip through login.
 *
 * On success it renders `children` directly; each consumer supplies its own page shell (width, header).
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    // Subscribe first so we never miss the first notification from initialize().
    const unsub = auth.onAuthStateChanged((s) => setState(s));
    void auth.initialize();
    return unsub;
  }, []);

  useEffect(() => {
    if (state !== null && !state.authenticated && !state.backendUnreachable) {
      // Read the query string from the live location (client-only effect) rather than
      // useSearchParams() — the latter forces a Suspense boundary on every authed page's prerender.
      const search = typeof window !== 'undefined' ? window.location.search : '';
      const here = `${pathname}${search}`;
      router.replace(`/admin/login?next=${encodeURIComponent(here)}`);
    }
  }, [state, router, pathname]);

  if (state === null) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }
  if (state.backendUnreachable) {
    return <CenteredMessage tone="error">Can&apos;t reach the server</CenteredMessage>;
  }
  if (!state.authenticated) {
    // Redirect handled by the effect above; render nothing while navigating.
    return null;
  }
  return <>{children}</>;
}

function CenteredMessage({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'error';
}) {
  const cls = tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400';
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <p className={`text-sm ${cls}`}>{children}</p>
    </main>
  );
}
