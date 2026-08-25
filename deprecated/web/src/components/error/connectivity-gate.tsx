'use client';

import { OfflineIndicator } from '@/components/error/offline-indicator';
import { ReconnectingBanner } from '@/components/error/reconnecting-banner';
import { useConnectivity } from '@/lib/api/connectivity';
import type { ReactNode } from 'react';

/**
 * Surfaces global backend-connectivity loss while the operator is mid-session. The shell + Composer
 * stay mounted through the whole outage so the operator's in-progress message is never destroyed: a
 * transient blip shows the accent <ReconnectingBanner>, and a sustained outage shows the persistent red
 * <OfflineIndicator> pill — the connectivity store keeps probing and auto-recovers underneath. This gate
 * never takes over the screen.
 *
 * The auth-driven <ServerUnreachable> (PrivateGuard, on `AuthState.backendUnreachable`) still covers the
 * boot/first-render case where no session was ever established — that full-screen takeover is correct
 * there and is unaffected by this gate.
 */
export function ConnectivityGate({ children }: { children: ReactNode }) {
  const status = useConnectivity();
  return (
    <>
      {children}
      {status === 'reconnecting' ? <ReconnectingBanner /> : null}
      {status === 'offline' ? <OfflineIndicator /> : null}
    </>
  );
}
