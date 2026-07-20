'use client';

import { ServerUnreachable } from '@/components/error/server-unreachable';
import { auth, type AuthState } from '@/lib/auth';
import { SITE_MAP, safeNext } from '@/lib/site-map';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Protected-route guards (the rs-crm/cubix pattern): subscribe to `auth.onAuthStateChanged`, render
 * `null` until the first callback (no flash of protected content), then redirect based on auth.
 * `onAuthStateChanged` only fires after the global `AuthInitializer` resolves `initialize()`.
 */

function FullScreenMessage({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'error';
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className={tone === 'error' ? 'text-[13px] text-red' : 'text-[13px] text-dim'}>
        {children}
      </p>
    </main>
  );
}

export function PrivateGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<AuthState | null>(null);
  const renderedAuthenticatedApp = useRef(false);

  useEffect(() => auth.onAuthStateChanged(setState), []);

  useEffect(() => {
    if (state && !state.authenticated && !state.backendUnreachable) {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      router.replace(SITE_MAP.auth.login({ next: `${pathname}${search}` }));
    }
  }, [state, router, pathname]);

  if (state === null) return <FullScreenMessage>Loading…</FullScreenMessage>;
  if (state.backendUnreachable && !renderedAuthenticatedApp.current) return <ServerUnreachable />;
  if (!state.authenticated) return null; // redirecting
  renderedAuthenticatedApp.current = true;
  return <>{children}</>;
}

export function PublicGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState | null>(null);
  const renderedPublicApp = useRef(false);

  useEffect(() => auth.onAuthStateChanged(setState), []);

  useEffect(() => {
    if (state?.authenticated) {
      const next =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('next')
          : null;
      router.replace(safeNext(next));
    }
  }, [state, router]);

  if (state === null) return <FullScreenMessage>Loading…</FullScreenMessage>;
  if (state.backendUnreachable && !renderedPublicApp.current) return <ServerUnreachable />;
  if (state.authenticated) return null; // redirecting
  renderedPublicApp.current = true;
  return <>{children}</>;
}
