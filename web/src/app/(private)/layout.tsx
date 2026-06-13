'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthState } from '@workspace/auth';
import { auth } from '@/lib/auth';
import AdminHeader from './_components/AdminHeader';

/**
 * Client-side route-protection layout for all routes under (private)/.
 *
 * Subscribes to auth state via auth.onAuthStateChanged() before calling
 * auth.initialize(). Shows a loading indicator while the session probe is
 * in flight, an inline error when the backend is unreachable, and redirects
 * to /admin/login when the user is not authenticated.
 *
 * Renders <AdminHeader />{children} once the session is confirmed.
 */
export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    // Subscribe first so we never miss the first notification from initialize().
    const unsub = auth.onAuthStateChanged((s) => setState(s));
    void auth.initialize();
    return unsub;
  }, []);

  useEffect(() => {
    if (state !== null && !state.authenticated && !state.backendUnreachable) {
      router.replace('/admin/login');
    }
  }, [state, router]);

  // Loading: session probe not completed yet.
  if (state === null) {
    return (
      <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      </main>
    );
  }

  // Backend down — show inline message rather than redirecting to login.
  if (state.backendUnreachable) {
    return (
      <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
        <p className="text-sm text-red-600 dark:text-red-400">Can't reach the server</p>
      </main>
    );
  }

  // Not authenticated — redirect handled by useEffect above; render nothing while navigating.
  if (!state.authenticated) {
    return null;
  }

  return (
    <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-3xl">
        <AdminHeader />
        {children}
      </div>
    </main>
  );
}
