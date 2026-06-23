'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ServerUnreachable } from '@/components/error/server-unreachable';
import { auth, type AuthState } from '@/lib/auth';
import { ROUTES, safeNext } from '@/lib/routes';

/**
 * Protected-route guards (the rs-crm/cubix pattern): subscribe to `auth.onAuthStateChanged`, render
 * `null` until the first callback (no flash of protected content), then redirect based on auth.
 * `onAuthStateChanged` only fires after the global `AuthInitializer` resolves `initialize()`.
 */

function FullScreenMessage({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className={tone === 'error' ? 'text-[13px] text-red' : 'text-[13px] text-dim'}>{children}</p>
    </main>
  );
}

/** Wraps the protected `(app)` group — unauth → /auth/login?next=… */
export function PrivateGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => auth.onAuthStateChanged(setState), []);

  useEffect(() => {
    if (state && !state.authenticated && !state.backendUnreachable) {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      router.replace(ROUTES.auth.login(`${pathname}${search}`));
    }
  }, [state, router, pathname]);

  if (state === null) return <FullScreenMessage>Loading…</FullScreenMessage>;
  if (state.backendUnreachable) return <ServerUnreachable />;
  if (!state.authenticated) return null; // redirecting
  return <>{children}</>;
}

/** Wraps the public `(auth)` group — authed users are bounced to the workspace (or `?next=`). */
export function PublicGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => auth.onAuthStateChanged(setState), []);

  useEffect(() => {
    if (state?.authenticated) {
      const next = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null;
      router.replace(safeNext(next));
    }
  }, [state, router]);

  if (state === null) return <FullScreenMessage>Loading…</FullScreenMessage>;
  if (state.backendUnreachable) return <ServerUnreachable />;
  if (state.authenticated) return null; // redirecting
  return <>{children}</>;
}
