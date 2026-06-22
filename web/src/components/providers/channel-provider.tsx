'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useChannelEvents, type StreamStatus } from '@/lib/api/events';
import { useChannels } from '@/lib/api/channels';

const STORAGE_KEY = 'atlas-channel';

interface ChannelContextValue {
  channels: string[];
  activeChannel: string | undefined;
  setActiveChannel: (channel: string) => void;
  isLoading: boolean;
  stream: StreamStatus;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

/**
 * Holds the active channel (≈ repo/project timeline) and owns the single SSE subscription for it.
 * The repo picker reads `channels` from `/web/channels`; the selection persists to localStorage and
 * defaults to the first active channel. Mounted inside the protected `(app)` shell only.
 */
export function ChannelProvider({ children }: { children: ReactNode }) {
  const { data: channels = [], isLoading } = useChannels();
  const [activeChannel, setActive] = useState<string | undefined>(undefined);

  // Resolve the active channel once channels load: stored value if still present, else the first.
  useEffect(() => {
    if (channels.length === 0) return;
    setActive((current) => {
      if (current && channels.includes(current)) return current;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return stored && channels.includes(stored) ? stored : channels[0];
    });
  }, [channels]);

  const setActiveChannel = (channel: string) => {
    setActive(channel);
    try {
      localStorage.setItem(STORAGE_KEY, channel);
    } catch {
      /* ignore */
    }
  };

  const stream = useChannelEvents(activeChannel);

  const value = useMemo(
    () => ({ channels, activeChannel, setActiveChannel, isLoading, stream }),
    [channels, activeChannel, isLoading, stream],
  );

  return <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>;
}

export function useChannel(): ChannelContextValue {
  const ctx = useContext(ChannelContext);
  if (!ctx) throw new Error('useChannel must be used within <ChannelProvider>');
  return ctx;
}
