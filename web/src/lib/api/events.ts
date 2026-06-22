'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { env } from '@/lib/env';
import { upsertByTs } from './message-cache';
import { qk } from './query-keys';
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
    // Direct cross-origin SSE to the Atlas app; `withCredentials` sends the session cookie so the
    // gated `/web/events` stream authorizes. The backend enables credentialed CORS for our origin.
    const es = new EventSource(
      `${env.NEXT_PUBLIC_ATLAS_HTTP_URL}/web/events?channel=${encodeURIComponent(channel)}`,
      { withCredentials: true },
    );

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
