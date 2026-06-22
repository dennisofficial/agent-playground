'use client';

import { CreateThread } from '@/features/create/components/create-thread';
import { Card } from '@/components/ui/card';

/**
 * Full-page `/new` — the hard-load / fallback for the intercepted modal. Same `<CreateThread/>` body
 * (single source), framed as a page with the onboarding explainer.
 */
export default function NewThreadPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-xl px-8 py-10">
        <h1 className="font-disp text-[22px] font-semibold text-text">Start a thread</h1>
        <p className="mt-1.5 text-[13px] text-dim">
          A thread spins up an isolated workspace where a Claude agent reads your code, plans the work,
          and ships one PR.
        </p>
        <Card className="mt-6 p-5">
          <CreateThread />
        </Card>
      </div>
    </div>
  );
}
