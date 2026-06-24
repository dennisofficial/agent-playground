'use client';

import { Modal } from '@/features/create/components/modal';
import { CreateThread } from '@/features/create/components/create-thread';

/**
 * Intercepted `/new` — the create-thread modal over the current view (the org rail / board stay behind
 * it). Creating navigates to the new thread, which pops the intercept; ✕ / backdrop / Esc `router.back()`.
 */
export default function NewThreadModal() {
  return (
    <Modal title="New thread" subtitle="Pick a repo and describe the work — Atlas starts the conversation.">
      <CreateThread />
    </Modal>
  );
}
