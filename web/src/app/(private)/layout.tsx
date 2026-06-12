'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/auth';

/**
 * Route-protection layout for all routes under (private)/.
 *
 * On mount:
 *  1. Subscribes to auth state changes — redirects to /admin/login whenever
 *     the user becomes unauthenticated (session expired, explicit sign-out).
 *  2. Calls auth.initialize() which probes /auth/session (and tries
 *     /auth/refresh on 401) to resolve the current cookie state.
 *
 * Shows a loading state while the session probe is in flight; renders null
 * (and triggers the redirect) if unauthenticated.
 */
export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let active = true;

    const unsub = auth.onAuthStateChanged((state) => {
      if (!active) return;
      setAuthenticated(state.authenticated);
      if (!state.authenticated && !state.backendUnreachable) {
        router.replace('/admin/login');
      }
    });

    auth
      .initialize()
      .catch(() => {
        /* network errors are reflected in auth state via backendUnreachable */
      })
      .finally(() => {
        if (active) setReady(true);
      });

    return () => {
      active = false;
      unsub();
    };
  }, [router]);

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        Loading…
      </div>
    );
  }

  if (!authenticated) return null;

  function handleSignOut() {
    auth.signOut();
    router.replace('/admin/login');
  }

  return (
    <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-3xl">
        <header className="mb-10 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
              Agent Playground — Admin
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              GitHub workspaces for the AI employees
            </p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Log out
          </button>
        </header>
        {children}
      </div>
    </main>
  );
}
