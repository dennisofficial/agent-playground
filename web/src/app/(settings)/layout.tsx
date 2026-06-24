import type { ReactNode } from 'react';
import { PrivateGuard } from '@/features/auth/components/guards';
import { OrgsProvider } from '@/components/providers/orgs-provider';

/**
 * Settings shell — a full-screen, authed surface that stands apart from the app chrome (no org rail /
 * thread sidebar). `OrgsProvider` makes the session orgs available so the settings screen can resolve the
 * targeted org by id. The screen renders its own top bar (see `OrgSettings`).
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <PrivateGuard>
      <OrgsProvider>
        <div className="flex h-dvh flex-col">{children}</div>
      </OrgsProvider>
    </PrivateGuard>
  );
}
