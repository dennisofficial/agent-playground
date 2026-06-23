'use client';

import type { ReactNode } from 'react';
import { ReconnectingBanner } from '@/components/error/reconnecting-banner';
import { ServerUnreachable } from '@/components/error/server-unreachable';
import { useConnectivity } from '@/lib/api/connectivity';

/**
 * Surfaces global backend-connectivity loss while the operator is mid-session. Mounted inside
 * `PrivateGuard` + `ChannelProvider` (so the SSE subscription stays alive through an outage and its
 * `onopen` helps prove recovery). A sustained outage reuses the full <ServerUnreachable> screen; a
 * transient blip shows the lightweight <ReconnectingBanner> over the shell.
 *
 * The auth-driven <ServerUnreachable> (PrivateGuard, on `AuthState.backendUnreachable`) still covers
 * boot/auth-call failures. At most one screen ever mounts: the guard short-circuits *before* this gate,
 * so if auth is unreachable the gate never renders.
 */
export function ConnectivityGate({ children }: { children: ReactNode }) {
  const status = useConnectivity();
  if (status === 'offline') return <ServerUnreachable />;
  return (
    <>
      {children}
      {status === 'reconnecting' ? <ReconnectingBanner /> : null}
    </>
  );
}
