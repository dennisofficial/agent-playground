'use client';

import { use, useEffect, type ReactNode } from 'react';
import { decodeThreadKey } from '@/lib/routes';
import { Navigator } from '@/features/thread-nav/components/navigator';
import { useChannel } from '@/components/providers/channel-provider';

/**
 * Thread shell (DRY): the Navigator column + the work-column frame. The Navigator persists across the
 * work-column sub-routes (conversation / plan / doc / phase). Re-points the active channel to the
 * thread's channel so the SSE subscription + sidebar follow a deep link.
 */
export default function ThreadLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ threadKey: string }>;
}) {
  const { threadKey } = use(params);
  const { channel, threadTs } = decodeThreadKey(threadKey);
  const { activeChannel, setActiveChannel } = useChannel();

  useEffect(() => {
    if (channel && channel !== activeChannel) setActiveChannel(channel);
  }, [channel, activeChannel, setActiveChannel]);

  return (
    <div className="flex h-full min-h-0">
      <Navigator threadKey={threadKey} channel={channel} threadTs={threadTs} />
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</section>
    </div>
  );
}
