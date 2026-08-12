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

/**
 * Which projects have an agent working somewhere inside them. Activity two levels down still belongs
 * at the top: from the project list you should be able to see that something is running without
 * opening the project to find out.
 *
 * `running` is a stable snapshot, so this re-queries only when the set of working threads actually
 * changes — and the `live` flag drops a resolved answer that arrived after the set moved on.
 */
export function useWorkingProjects(running: string[]): string[] {
  const { workspaceService } = useServices();
  const [working, setWorking] = useState<string[]>([]);

  useEffect(() => {
    if (running.length === 0) {
      setWorking([]);
      return;
    }
    let live = true;
    void workspaceService.projectsWithRunningThreads(running).then((ids) => {
      if (live) setWorking(ids);
    });
    return () => {
      live = false;
    };
  }, [running, workspaceService]);

  return working;
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
