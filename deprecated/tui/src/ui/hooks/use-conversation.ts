import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConversationState } from "../../app/conversation.store.js";
import { spinnerFrame } from "../theme.js";
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

  return { now, frame: spinnerFrame(now) };
}

/**
 * The working line's own clock, faster than the page's and mounted only while a turn is in flight.
 *
 * The sweep moves a cell every 18ms, so at the page's 100ms tick the crest would jump five cells at
 * a time and read as a strobe rather than as travel. It is a SEPARATE clock rather than a faster
 * page tick because `useTick` re-renders the whole transcript: the shimmer needs 25 frames a second
 * from one line, not from every block above it.
 */
export function useShimmerClock(active: boolean, intervalMs = 40): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}
