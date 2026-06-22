'use client';

import { use } from 'react';
import { decodeThreadKey } from '@/lib/routes';
import { MessageStream } from '@/features/conversation/components/message-stream';
import { Composer } from '@/features/conversation/components/composer';
import { usePipelineOutline } from '@/lib/api/pipeline';

/** Default work view — the Conversation (the thread's brain). */
export default function ConversationPage({
  params,
}: {
  params: Promise<{ threadKey: string }>;
}) {
  const { threadKey } = use(params);
  const { channel, threadTs } = decodeThreadKey(threadKey);
  const outline = usePipelineOutline(channel, threadTs);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageStream channel={channel} threadTs={threadTs} threadKey={threadKey} live={outline.live} />
      <Composer channel={channel} threadTs={threadTs} />
    </div>
  );
}
