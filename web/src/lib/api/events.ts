'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { upsertByTs } from './messages';
import { qk } from './queries';
import type { WebOutboundMessage } from './types';

export type StreamStatus = 'connecting' | 'open' | 'error';

/**
 * Subscribe to the channel's SSE stream and merge each `WebOutboundMessage` into the shared
 * `channel-messages` cache, upserting by `ts` (an edited card re-emits with the same ts → repaint in
 * place). Mount once per active channel (in the app shell). `EventSource` reconnects automatically.
 */
export function useChannelEvents(channel: string | undefined): StreamStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (!channel) return;
    setStatus('connecting');
    const es = new EventSource(`/web/events?channel=${encodeURIComponent(channel)}`);

    es.onopen = () => setStatus('open');
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as WebOutboundMessage;
        if (msg.channel !== channel) return;
        qc.setQueryData<WebOutboundMessage[]>(qk.channelMessages(channel), (prev) =>
          upsertByTs(prev ?? [], { ...msg, author: 'atlas' }),
        );
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => setStatus('error'); // EventSource retries on its own.

    return () => es.close();
  }, [channel, qc]);

  return status;
}
