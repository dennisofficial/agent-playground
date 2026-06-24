import type { ReactNode } from 'react';
import { PrivateGuard } from '@/features/auth/components/guards';
import { ConnectivityGate } from '@/components/error/connectivity-gate';
import { OrgsProvider } from '@/components/providers/orgs-provider';
import { AppChrome } from '@/features/shell/components/app-chrome';

/**
 * Protected app shell. `PrivateGuard` gates on auth; `OrgsProvider` holds the session orgs + the org-rail
 * filter (a label, not a switch); `ConnectivityGate` surfaces a mid-session backend outage (banner → full
 * ServerUnreachable) — it reads a standalone connectivity store, so it needs no SSE provider; `AppChrome`
 * renders the persistent TopBar + OrgRail + Sidebar + palette and the `@dialog` parallel slot.
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
      <OrgsProvider>
        <ConnectivityGate>
          <AppChrome dialog={dialog}>{children}</AppChrome>
        </ConnectivityGate>
      </OrgsProvider>
    </PrivateGuard>
  );
}
