'use client';

import { CreateThread } from '@/features/create/components/create-thread';

/**
 * Full-page `/new` — the create-thread fallback for a hard load (the intercepted modal handles in-app
 * navigation). Same form, same source.
 */
export default function NewThreadPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-lg px-6 py-10">
        <h1 className="font-disp text-[20px] font-semibold text-text">New thread</h1>
        <p className="mb-6 mt-1 text-[13px] text-dim">
          Pick a repo and describe the work — Atlas starts the conversation.
        </p>
        <CreateThread />
      </div>
    </div>
  );
}
