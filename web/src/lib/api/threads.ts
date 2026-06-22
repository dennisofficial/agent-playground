'use client';

import { useMemo } from 'react';
import { useChannelMessages } from './messages';
import { deriveThreadSummaries } from './thread-summaries';

// ── Thread list (DEMO/live-outbox derivation — see BACKEND_GAPS.md #1) ─────────────────────────────
export function useThreadList(channel: string | undefined) {
  const { data, isLoading, isError } = useChannelMessages(channel);
  const threads = useMemo(
    () => (channel && data ? deriveThreadSummaries(channel, data) : []),
    [channel, data],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    if (data) for (const m of data) map.set(m.threadTs ?? m.ts, (map.get(m.threadTs ?? m.ts) ?? 0) + 1);
    return map;
  }, [data]);
  return { threads, counts, isLoading, isError };
}
