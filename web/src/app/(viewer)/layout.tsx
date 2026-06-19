'use client';

import { AuthGate } from '@/components/auth-gate';

/**
 * Auth-guarded shell for the Plan Viewer (`/plans/...`). Same gate as the admin shell, but a WIDE
 * content column (max-w-6xl) — diagrams, dependency graphs, and phase timelines need the room the
 * narrow admin column (max-w-3xl) can't give.
 */
export default function ViewerLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-10 font-sans dark:bg-black">
        <div className="w-full max-w-6xl">{children}</div>
      </main>
    </AuthGate>
  );
}
