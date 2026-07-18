'use client';

import { CreateThread } from '@/features/create/components/create-job';
import { Modal } from '@/features/create/components/modal';
import { Suspense } from 'react';

/**
 * Intercepted `/new` — the create-job modal over the current view (the org rail / board stay behind
 * it). Creating navigates to the new thread, which pops the intercept; ✕ / backdrop / Esc `router.back()`.
 */
export default function NewThreadModal() {
  return (
    <Modal
      title="New job"
      subtitle="Pick a repo and describe the work — Atlas starts the conversation."
    >
      {/* `CreateThread` reads `?org=&repo=` via `useSearchParams`, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <CreateThread />
      </Suspense>
    </Modal>
  );
}
