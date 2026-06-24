'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { env } from '@/lib/env';
import { connectivity } from './connectivity';
import { upsertByTs } from './message-cache';
import { qk } from './query-keys';
import { refreshSession } from './refresh';
import type { WebOutboundMessage } from './types';

export type StreamStatus = 'connecting' | 'open' | 'error';

/**
 * Subscribe to the channel's SSE stream and merge each `WebOutboundMessage` into the shared
 * `channel-messages` cache, upserting by `ts` (an edited card re-emits with the same ts → repaint in
 * place). Mount once per active channel (in the app shell). `EventSource` reconnects transient drops
 * itself; a FATAL close (e.g. the access cookie expired → 401, which EventSource never retries) triggers
 * one session refresh + reconnect so the live stream survives token rotation without a page reload.
 */
export function useChannelEvents(channel: string | undefined): StreamStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (!channel) return;
    let es: EventSource | null = null;
    let closed = false; // the effect was torn down (channel change / unmount)
    let refreshedOnce = false; // at most one refresh+reconnect per live connection

    const connect = () => {
      if (closed) return;
      setStatus('connecting');
      // Direct cross-origin SSE to the Atlas app; `withCredentials` sends the session cookie so the
      // gated `/web/events` stream authorizes. The backend enables credentialed CORS for our origin.
      es = new EventSource(
        `${env.NEXT_PUBLIC_HTTP_URL}/web/events?channel=${encodeURIComponent(channel)}`,
        { withCredentials: true },
      );

      es.onopen = () => {
        refreshedOnce = false; // a healthy connection re-arms the guard for the next expiry
        connectivity.reportReachable(); // the stream connected → backend is up
        setStatus('open');
      };
      es.onmessage = (e: MessageEvent<string>) => {
        connectivity.reportReachable(); // a live frame proves the backend is up (no-op when already healthy)
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
      es.onerror = () => {
        connectivity.reportUnreachable(); // stream dropped — arm the global outage signal (debounced)
        setStatus('error');
        // CONNECTING (0): a transient drop — EventSource reconnects on its own, leave it.
        // CLOSED (2): fatal (e.g. a 401 on an expired cookie) — EventSource will NOT retry. Refresh once
        // and rebuild the stream; if the refresh fails, `refreshSession` has already signed the operator
        // out (→ redirect), so we just stop here.
        if (!es || es.readyState !== EventSource.CLOSED || refreshedOnce) return;
        refreshedOnce = true;
        void refreshSession().then((ok) => {
          if (ok && !closed) {
            es?.close();
            connect();
          }
        });
      };
    };

    connect();
    return () => {
      closed = true;
      es?.close();
    };
  }, [channel, qc]);

  return status;
}
