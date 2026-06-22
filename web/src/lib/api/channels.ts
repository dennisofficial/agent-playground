'use client';

import { useQuery } from '@tanstack/react-query';
import { webClient } from './client';
import { qk } from './query-keys';

// ── Channels (repo picker) ───────────────────────────────────────────────────────────────────────
export function useChannels() {
  return useQuery({
    queryKey: qk.channels(),
    queryFn: async () => (await webClient.channels()).channels,
    staleTime: 30_000,
  });
}
