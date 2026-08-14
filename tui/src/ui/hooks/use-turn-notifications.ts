import { useRenderer } from "@opentui/react";
import { useEffect, useRef } from "react";
import {
  finishedThreads,
  turnNotification,
} from "../../domain/turn-notification.js";
import { useServices } from "../services.js";
import { useRunningThreads } from "./use-conversation.js";

/**
 * Tell the desktop when an agent stops and leaves the ball with you.
 *
 * Driven by the LOCAL lane set — `useRunningThreads` reads this process's `TurnRunnerService`, not
 * the database — and that is the whole de-duplication story. The engine runs in-process, so a turn
 * belongs to exactly one Atlas instance; watching the derived attention state instead would have
 * every open terminal fire for every job. The work is already split across processes, so the
 * notifications are too. See `domain/turn-notification.ts`.
 *
 * Mounted once, at the top of the app, deliberately: the signal is "a turn this process ran has
 * ended", which is true whatever page happens to be on screen. A hook living on the conversation
 * page would notify only about the job you are already looking at — the one case that needs no
 * banner at all.
 */
export function useTurnNotifications(args: {
  /** The thread whose transcript is on screen, if any. It gets no banner — you can see it. */
  openThreadId: string | null;
}): void {
  const renderer = useRenderer();
  const { attentionService } = useServices();
  const running = useRunningThreads();

  /**
   * The previous reading. Seeded EMPTY rather than from the first snapshot, and the difference does
   * not matter: only departures are news, so a turn already in flight when the app started is
   * absent from `before`, produces no departure on its first tick, and notifies normally when it
   * actually ends.
   */
  const before = useRef<readonly string[]>([]);
  // Read inside the effect rather than listed as a dependency: it changes on every navigation, and
  // re-running this on navigation would compare the lane set against itself and find no departures
  // — harmless, but it would also make the ref's meaning "since the last render" instead of "since
  // the last time the lanes moved".
  const openThreadId = useRef(args.openThreadId);
  openThreadId.current = args.openThreadId;

  useEffect(() => {
    const finished = finishedThreads({ before: before.current, now: running });
    before.current = running;
    if (finished.length === 0) return;

    let live = true;
    for (const threadId of finished) {
      void attentionService
        .jobAttentionAfterTurn({ threadId, runningThreadIds: running })
        .then((state) => {
          if (!live || !state) return;
          const notification = turnNotification({
            jobTitle: state.jobTitle,
            attention: state.attention,
            onScreen: threadId === openThreadId.current,
          });
          if (!notification) return;
          // Returns false where the terminal has no notification protocol. Nothing to do about it
          // and nowhere to say so — stdout belongs to the renderer — so the banner is simply best
          // effort, exactly like the terminal's own bell.
          renderer.triggerNotification(notification.message, notification.title);
        })
        // A turn that ended is not undone by failing to announce it. The job row already says what
        // needs the human; this is the convenience on top, and it must never surface an error.
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [attentionService, renderer, running]);
}
