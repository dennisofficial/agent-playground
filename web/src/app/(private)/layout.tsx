'use client';

import { AuthGate } from '@/components/auth-gate';
import AdminHeader from './_components/AdminHeader';

/**
 * Auth-guarded shell for the admin routes under (private)/. Auth probe + redirect live in the
 * shared <AuthGate>; this layout supplies the admin chrome + the narrow (max-w-3xl) content column.
 */
export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
        <div className="w-full max-w-3xl">
          <AdminHeader />
          {children}
        </div>
      </main>
    </AuthGate>
  );
}
