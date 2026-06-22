'use client';

import { useRouter } from 'next/navigation';
import { Modal } from '@/components/create/modal';
import { CreateThread } from '@/components/create/create-thread';

/**
 * Intercepted `/new` — opens the create-thread form as a modal over the current view (soft nav). A
 * hard load of `/new` falls through to the full-page `(app)/new/page.tsx` (same `<CreateThread/>`).
 */
export default function NewThreadModal() {
  const router = useRouter();
  return (
    <Modal
      title="Start a thread"
      subtitle="A thread is one piece of work — its own isolated workspace, branch, and PR."
    >
      <CreateThread onDone={() => router.back()} />
    </Modal>
  );
}
