'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { auth, type AuthState } from '@/lib/auth';
import { ROUTES } from '@/lib/routes';

/** Redirect hub — sends the operator to the workspace (authed) or the login screen. */
export default function Home() {
  const router = useRouter();
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => auth.onAuthStateChanged(setState), []);

  useEffect(() => {
    if (!state || state.backendUnreachable) return;
    router.replace(state.authenticated ? ROUTES.workspace() : ROUTES.auth.login());
  }, [state, router]);

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="text-[13px] text-dim">
        {state?.backendUnreachable ? "Can't reach the server" : 'Loading…'}
      </p>
    </main>
  );
}
