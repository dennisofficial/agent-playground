import type { ReactNode } from "react";
import { PrivateGuard } from "@/features/auth/components/guards";

/**
 * Settings shell — a full-screen, authed surface that stands apart from the app chrome (no sidebar). The
 * settings screen resolves its targeted org by id from the session (`useOrgs()` / `useOrg()`); it renders
 * its own top bar (see `OrgSettings`).
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <PrivateGuard>
      <div className="flex h-dvh flex-col">{children}</div>
    </PrivateGuard>
  );
}
