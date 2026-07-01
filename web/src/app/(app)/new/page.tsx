'use client';

import { Suspense } from 'react';
import { CreateThread } from '@/features/create/components/create-job';

/**
 * Full-page `/new` — the create-job fallback for a hard load (the intercepted modal handles in-app
 * navigation). Same form, same source.
 */
export default function NewThreadPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-lg px-6 py-10">
        <h1 className="font-disp text-[20px] font-semibold text-text">New job</h1>
        <p className="mb-6 mt-1 text-[13px] text-dim">
          Pick a repo and describe the work — Atlas starts the conversation.
        </p>
        {/* `CreateThread` reads `?org=&repo=` via `useSearchParams`, which needs a Suspense boundary. */}
        <Suspense fallback={null}>
          <CreateThread />
        </Suspense>
      </div>
    </div>
  );
}
