import type { ThreadMessageView } from '@workspace/shared';
import type { JobMessage } from './job-api';
import type { WebCard } from './types';

/**
 * Project a durable message view onto the conversation's normalized `JobMessage`.
 *
 * TODO(view-model): this is the LAST remaining view-model mirror. `JobMessage` is a field-renamed
 * `ThreadMessageView` (`ts`←`id`, `authorName`←`author`, `author`←`isAtlas`, plus the typed `card`
 * narrowing). Collapsing it onto `ThreadMessageView` + a couple of helpers is deferred — it's mostly
 * mechanical rename churn across the conversation bubbles. The job read-model view-model (`PipelineJob`
 * and friends) has already collapsed onto shared DTOs + `job-workspace/lib/pipeline-selectors.ts`.
 */
export function threadMessageToJobMessage(v: ThreadMessageView): JobMessage {
  return {
    ts: v.id,
    threadId: v.threadId,
    subagentId: v.subagentId,
    subagentStatus: v.subagentStatus ?? null,
    subagentEndedAt: v.subagentEndedAt ?? null,
    author: v.isAtlas ? 'atlas' : 'user',
    authorId: v.authorId,
    authorName: v.author,
    text: v.text ?? '',
    kind: v.kind,
    source: v.source,
    card: (v.card ?? undefined) as WebCard | undefined,
    meta: v.meta ?? undefined,
    postedAt: v.postedAt,
    orderAt: v.orderAt,
  };
}
