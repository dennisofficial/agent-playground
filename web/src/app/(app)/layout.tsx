import type { ReactNode } from 'react';
import { PrivateGuard } from '@/features/auth/components/guards';
import { ConnectivityGate } from '@/components/error/connectivity-gate';
import { ChannelProvider } from '@/components/providers/channel-provider';
import { AppChrome } from '@/features/shell/components/app-chrome';

/**
 * Protected app shell. `PrivateGuard` gates on auth; `ChannelProvider` holds the active channel and
 * owns the single SSE subscription; `ConnectivityGate` surfaces a mid-session backend outage (banner →
 * full ServerUnreachable) without unmounting the SSE; `AppChrome` renders the persistent TopBar +
 * Sidebar + palette and the `@dialog` parallel slot (the create-thread modal).
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
      <ChannelProvider>
        <ConnectivityGate>
          <AppChrome dialog={dialog}>{children}</AppChrome>
        </ConnectivityGate>
      </ChannelProvider>
    </PrivateGuard>
  );
}
