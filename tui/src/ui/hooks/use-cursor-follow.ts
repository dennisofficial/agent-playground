import { useEffect, useRef } from "react";
import type { OpenConversation } from "../../app/conversation.service.js";
import type { Thread } from "../../generated/prisma/client.js";
import { useRunningThreads } from "./use-conversation.js";
import { useServices } from "../services.js";

/**
 * Follow the job's cursor while a conversation is on screen.
 *
 * The cursor is orchestration state and an agent moves it MID-TURN: `open_thread` takes Dennis to
 * the thread it opened, and that thread's `complete_thread` hands him back to the one waiting on it.
 * Without this the page he is on quietly stops being where the work is.
 *
 * Driven by the turn runner's signal rather than a timer: every cursor move is followed by a turn
 * starting or ending somewhere, which is exactly when this fires and is already the signal the
 * thread list re-reads on. A poll would ask a hundred times for one answer.
 */
export function useCursorFollow(args: {
  /** Null while no conversation is on screen — browsing follows nothing. */
  open: OpenConversation | null;
  /** The cursor left this thread for that one. */
  onMoved: (thread: Thread) => void;
  /** Same thread, different truth about it — it closed under us. */
  onRefreshed: (open: OpenConversation) => void;
}): void {
  const { conversationService } = useServices();
  const running = useRunningThreads();
  /**
   * Deliberately NOT seeded from the open thread. The rule is that the cursor moved OFF this thread,
   * which only two readings can establish; seeded with `open.thread.id` the first reading would look
   * like a move every time the human browsed to a sibling by hand — the one case that must not
   * follow, since he chose to be there.
   */
  const cursor = useRef<string | null>(null);
  const handlers = useRef(args);

  useEffect(() => {
    handlers.current = args;
  });

  const threadId = args.open?.thread.id ?? null;

  useEffect(() => {
    let live = true;
    void conversationService
      .syncCursor({ lastCursorThreadId: cursor.current })
      .then((sync) => {
        if (!live || !sync) return;
        cursor.current = sync.cursorThreadId;
        if (sync.moved) return handlers.current.onMoved(sync.moved);
        if (sync.refreshed) handlers.current.onRefreshed(sync.refreshed);
      })
      // A cursor that could not be read is a cursor that did not move: the next turn boundary asks
      // again, and a failed read must never be what takes the page away from the human.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [conversationService, running, threadId]);
}
