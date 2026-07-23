'use client';

import type { JobRef, MessageInput } from '@/lib/api/job-api';
import { useSendMessageMutation } from '@/redux/query/api/jobs.api';
import type { InboundItemInput } from '@workspace/shared';

/** The composer's send input — a typed batch plus the lane/thread it targets. */
export interface SendInput {
  messages: MessageInput[];
  threadId?: string;
}

/** Fire-and-settle callbacks, matching the composer's existing `mutate(input, { onSuccess, onError })` shape. */
export interface SendCallbacks {
  onSuccess?: () => void;
  onError?: (err: Error) => void;
}

/** Map the composer's typed batch to the endpoint's inbound items — no flattening: each item is preserved so it
 *  lands as its own inbound row and renders structurally. The composer's `user` item IS the operator turn. */
function toInboundItems(messages: MessageInput[]): InboundItemInput[] {
  const items: InboundItemInput[] = [];
  for (const m of messages) {
    if (m.type === 'user') {
      // The thread IS the lane, so the legacy `lane` field is dropped — targeting rides on `threadId`.
      const text = m.text.trim();
      if (text) items.push({ type: 'operator', text });
    } else {
      // answer_question / file_answered / secret_provided are structurally the same on both sides.
      items.push(m);
    }
  }
  return items;
}

export function useSendMessage(ref: JobRef) {
  const [sendMessage, state] = useSendMessageMutation();
  const mutate = (input: SendInput, cb?: SendCallbacks): void => {
    const messages = toInboundItems(input.messages);
    // An empty batch (e.g. the attachments-only promote follow-up) has nothing to send on the new path.
    if (messages.length === 0) {
      cb?.onSuccess?.();
      return;
    }
    sendMessage({ jobId: ref.jobId, messages, threadId: input.threadId })
      .unwrap()
      .then(() => cb?.onSuccess?.())
      .catch((err: unknown) => cb?.onError?.(err instanceof Error ? err : new Error(String(err))));
  };
  // `isPending`/`isError` mirror the composer's old tanstack-mutation surface (RTK names them isLoading/isError).
  return { mutate, isPending: state.isLoading, isError: state.isError };
}
