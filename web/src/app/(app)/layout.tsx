import type { ReactNode } from 'react';
import { PrivateGuard } from '@/features/auth/components/guards';
import { ConnectivityGate } from '@/components/error/connectivity-gate';
import { AppChrome } from '@/features/shell/components/app-chrome';

/**
 * Protected app shell. `PrivateGuard` gates on auth; `ConnectivityGate` surfaces a mid-session backend
 * outage (banner → full ServerUnreachable) — it reads a standalone connectivity store, so it needs no SSE
 * provider; `AppChrome` renders the persistent sidebar (org → repo → thread) + the ⌘K palette and the
 * `@dialog` parallel slot. The session orgs come straight from `useOrgs()` (no provider needed).
 */
export default function AppLayout({
  children,
  dialog,
}: {
  children: ReactNode;
  dialog: ReactNode;
}) {
  return (
    <PrivateGuard>
      <ConnectivityGate>
        <AppChrome dialog={dialog}>{children}</AppChrome>
      </ConnectivityGate>
    </PrivateGuard>
  );
}
