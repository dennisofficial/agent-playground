import type { ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Message } from "../../domain/message.js";
import { firstUnseenIndex, isPinnedToBottom } from "../../domain/read-state.js";
import { UNSEEN_ANCHOR_ID } from "../components/new-divider.js";
import { useServices } from "../services.js";

/**
 * How often the transcript is asked where it is.
 *
 * OpenTUI's scrollbox emits no scroll event, and three of the ways you can reach the bottom (the
 * wheel, a drag, sticky-scroll following a turn) do not pass through React at all — so this is a
 * poll rather than a handler. It reads three numbers and writes only when the newest message
 * changes, which is a few times per turn, not four times a second.
 */
const POLL_MS = 250;

export type ReadState = {
  /** Attach to the transcript's scrollbox. */
  scroller: RefObject<ScrollBoxRenderable | null>;
  /** The oldest message you have not seen, frozen for the visit. Null when there is nothing new. */
  anchorMessageId: string | null;
  /** Whether to draw `─── new ───` above it — false when everything is new. */
  showDivider: boolean;
  pinned: boolean;
  handleJumpToBottom: () => void;
};

/**
 * Read state, from the transcript's side: where to land, where to draw the rule, and when to write
 * `Thread.lastSeenAt`.
 *
 * The rule the whole thing turns on: **seen means you reached the BOTTOM**, not that you mounted
 * the page. While you are sitting at the bottom, arriving messages write through — so a thread you
 * are watching never accumulates unread, and nothing has to ask whether the window is focused.
 */
export function useReadState(args: {
  threadId: string;
  /** `Thread.lastSeenAt` as it stood when the conversation opened — deliberately not live. */
  lastSeenAt: Date | null;
  messages: readonly Message[];
}): ReadState {
  const { attentionService } = useServices();
  const scroller = useRef<ScrollBoxRenderable>(null);
  const [anchor, setAnchor] = useState<{ id: string; index: number } | null>(null);
  const [pinned, setPinned] = useState(true);

  // Frozen on the first load that has any messages in it, then never recomputed: a boundary that
  // moves while you are reading makes the thing it was marking unfindable.
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || args.messages.length === 0) return;
    decided.current = true;
    const index = firstUnseenIndex({ messages: args.messages, lastSeenAt: args.lastSeenAt });
    const message = index >= 0 ? args.messages[index] : undefined;
    if (message) setAnchor({ id: message.id, index });
  }, [args.messages, args.lastSeenAt]);

  // The live view of the messages, read by the interval below without making it re-subscribe on
  // every block that lands.
  const messagesRef = useRef(args.messages);
  useEffect(() => {
    messagesRef.current = args.messages;
  }, [args.messages]);

  const landed = useRef(false);
  const writtenFor = useRef<number | null>(null);
  const hasAnchor = anchor !== null;
  /**
   * The last thing the poll SAW, which is a different question from `pinned` — `null` means it has
   * not looked yet. The leaving write below turns on it, and a boolean seeded `true` would claim a
   * bottom nobody had measured on a page closed inside the first tick.
   */
  const atBottom = useRef<boolean | null>(null);

  useEffect(() => {
    const write = (): void => {
      const newest = messagesRef.current[messagesRef.current.length - 1];
      if (!newest) return;
      const at = newest.createdAt.getTime();
      if (writtenFor.current === at) return;
      writtenFor.current = at;
      // Stamped now rather than at the message: `now` is when you were observed at the bottom, and
      // a message that lands a millisecond later is genuinely unseen.
      void attentionService.markSeen({ threadId: args.threadId, at: new Date() });
    };

    const timer = setInterval(() => {
      const box = scroller.current;
      if (!box) return;

      // The landing waits for the anchor to have been laid out — on a long transcript that is
      // several frames after the messages arrive, so it is attempted until it takes rather than
      // fired once into an empty content box.
      if (hasAnchor && !landed.current) {
        if (!box.content.findDescendantById(UNSEEN_ANCHOR_ID)) return;
        box.scrollChildIntoView(UNSEEN_ANCHOR_ID);
        landed.current = true;
        return;
      }

      const bottom = isPinnedToBottom({
        scrollTop: box.scrollTop,
        scrollHeight: box.scrollHeight,
        viewportHeight: box.viewport.height,
      });
      atBottom.current = bottom;
      setPinned(bottom);
      if (bottom) write();
    }, POLL_MS);

    return () => {
      clearInterval(timer);
      // Written on the way OUT as well, because the poll's last tick is up to 250 ms behind the
      // last message and leaving is frequently what happens in between: a thread that advances
      // itself puts its sign-off on screen and then hands the cursor on, and without this the
      // record you just read would carry an unread dot for a paragraph you watched arrive.
      //
      // Off the last OBSERVED position rather than a fresh measurement — the scrollbox is being
      // torn down and its geometry is no longer trustworthy — so scrolling up and leaving still
      // leaves the thread unread, which is the honest answer.
      if (atBottom.current === true) write();
    };
  }, [attentionService, args.threadId, hasAnchor]);

  const handleJumpToBottom = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    box.scrollTo(Math.max(0, box.scrollHeight - box.viewport.height));
  }, []);

  return {
    scroller,
    anchorMessageId: anchor?.id ?? null,
    // No rule above the first message: everything being new is not a boundary between two things.
    showDivider: (anchor?.index ?? 0) > 0,
    pinned,
    handleJumpToBottom,
  };
}
