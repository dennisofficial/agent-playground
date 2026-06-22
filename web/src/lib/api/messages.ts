'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { webClient } from './client';
import { qk } from './query-keys';
import { selectThreadMessages } from './message-cache';

// ── Whole-channel message cache (history hydrate; SSE keeps it live) ───────────────────────────────
export function useChannelMessages(channel: string | undefined) {
  return useQuery({
    queryKey: qk.channelMessages(channel ?? ''),
    queryFn: () => webClient.thread(channel as string),
    enabled: !!channel,
    // Live updates arrive over SSE; never auto-refetch (it would clobber optimistic user messages).
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ── One thread's messages (root-coalesced) ─────────────────────────────────────────────────────────
export function useThreadMessages(channel: string | undefined, threadTs: string) {
  const { data, isLoading, isError } = useChannelMessages(channel);
  const messages = useMemo(
    () => (data ? selectThreadMessages(data, threadTs) : []),
    [data, threadTs],
  );
  return { messages, isLoading, isError };
}
