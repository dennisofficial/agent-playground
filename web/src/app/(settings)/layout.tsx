import type { ReactNode } from "react";
import { PrivateGuard } from "@/features/auth/components/guards";

/**
 * Settings shell — a full-screen, authed surface that stands apart from the app chrome (no jobs sidebar),
 * but reuses the app-wide `TopBar`. The settings screen resolves its targeted org by id from the session
 * (`useOrgs()` / `useOrg()`) and renders the shared top bar + its own section nav (see `OrgSettingsLayout`).
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <PrivateGuard>
      <div className="flex h-dvh flex-col">{children}</div>
    </PrivateGuard>
  );
}
