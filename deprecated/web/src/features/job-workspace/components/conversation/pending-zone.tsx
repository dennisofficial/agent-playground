'use client';

import { useGetInboundQuery } from '@/redux/query/api/jobs.api';
import { EInboundMessageStatus, EInboundPriority } from '@workspace/shared';
import { UserBubble } from './bubbles/bubbles';

export function PendingZone({ jobId, threadId }: { jobId: string; threadId?: string }) {
  const { data } = useGetInboundQuery(jobId);
  const pending = (data ?? []).filter(
    (m) =>
      m.status === EInboundMessageStatus.PENDING &&
      m.priority !== EInboundPriority.LATER &&
      (!threadId || m.threadId === threadId),
  );
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((m) => (
        <UserBubble
          key={m.id}
          text={m.text}
          pending
          pendingLabel="queued · waiting for the model"
        />
      ))}
    </>
  );
}
