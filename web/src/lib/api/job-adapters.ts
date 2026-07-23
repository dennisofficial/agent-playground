import type { ThreadMessageView } from '@workspace/shared';
import type { JobMessage } from './job-api';
import type { WebCard } from './types';

export function threadMessageToJobMessage(v: ThreadMessageView): JobMessage {
  return {
    ts: v.id,
    threadId: v.threadId,
    subagentId: v.subagentId,
    subagentStatus: v.subagentStatus ?? null,
    subagentEndedAt: v.subagentEndedAt ?? null,
    text: v.text ?? '',
    kind: v.kind,
    source: v.source,
    card: (v.card ?? undefined) as WebCard | undefined,
    meta: v.meta ?? undefined,
    postedAt: v.postedAt,
    orderAt: v.orderAt,
  };
}
