import { BrandLockup } from '@/components/ui/brand';
import { PublicGuard } from '@/features/auth/components/guards';
import type { ReactNode } from 'react';

/**
 * Public auth shell: the Atlas grid background (from <body>), brand lockup above a centered 396px
 * column. `PublicGuard` bounces already-authed operators to the workspace. Each screen renders its
 * own card into {children}.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <PublicGuard>
      <main className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-[396px]">
          <div className="mb-8 flex justify-center">
            <BrandLockup size="lg" showCaption />
          </div>
          {children}
        </div>
      </main>
    </PublicGuard>
  );
}
