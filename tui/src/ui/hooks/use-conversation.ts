import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConversationState } from "../../app/conversation.store.js";
import { SPINNER_FRAMES } from "../theme.js";
import { useServices } from "../services.js";

export function useConversation(threadId: string): ConversationState {
  const { conversationStores } = useServices();
  const store = conversationStores.for(threadId);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useRunningThreads(): string[] {
  const { turnRunnerService } = useServices();
  return useSyncExternalStore(
    turnRunnerService.subscribe,
    turnRunnerService.getRunningThreadIds,
  );
}

/** A clock for elapsed time and spinner frames. Only mounted while something is actually running. */
export function useTick(
  active: boolean,
  intervalMs = 100,
): { now: number; frame: string } {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  const index = Math.floor(now / 80) % SPINNER_FRAMES.length;
  return { now, frame: SPINNER_FRAMES[index] as string };
}
