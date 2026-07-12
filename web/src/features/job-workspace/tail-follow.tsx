"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tail-following for a streaming scroll container — the "pin to bottom while reading the tail, but don't
 * yank me back down if I've scrolled up" behavior shared by the main conversation and the subagent run
 * view. While the view is stuck at (or near) the bottom, new content auto-scrolls into view; once the user
 * scrolls up, auto-scroll pauses and a "Jump to latest" affordance ({@link JumpToLatestButton}) appears.
 *
 * Usage:
 *   const tail = useTailFollow([items.length, active]);
 *   <div className="relative h-full min-h-0">
 *     <div ref={tail.scrollRef} onScroll={tail.onScroll} className="h-full overflow-y-auto">
 *       …content…
 *       <div ref={tail.endRef} />
 *     </div>
 *     {tail.showJump ? <JumpToLatestButton onClick={tail.jumpToLatest} /> : null}
 *   </div>
 *
 * Pass a `deps` array that changes whenever new content lands (block count, a streamed-text length
 * signature, an "is streaming" flag) — the re-scroll fires on those changes, mirroring the conversation.
 *
 * `pin` overrides HOW we snap to the bottom. The default (`endRef.scrollIntoView`) assumes every row above
 * is real DOM so `scrollHeight` is exact. A VIRTUALIZED caller (the main conversation) renders off-screen
 * rows with ESTIMATED heights, so `scrollIntoView` can land short — it passes a `pin` that drives the
 * virtualizer's own scroll-to-index instead. When `pin` is set it also backs `jumpToLatest`.
 *
 * Auto-scroll also pauses while the pointer hovers interactive content (`onPointerOver`/`onPointerLeave`,
 * wired on the scroll container). Otherwise a card streaming new tokens bumps up a frame before a click
 * and steals the target. On release we re-measure, so following resumes only if still at the tail.
 */

// An element counts as "interactive" (hovering it pauses tail-follow) if it is, or sits inside, a marked
// card (`data-tailpause`) or a native control. Cards mark their whole body so the pause covers the padding
// the pointer crosses on the way to a button, not just the button itself.
const INTERACTIVE_SELECTOR =
  '[data-tailpause], button, a[href], input, textarea, select, [role="button"], [role="textbox"]';

export function useTailFollow(deps: React.DependencyList, pin?: () => void) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Whether the view is "tailing" — pinned at (or near) the bottom. We only auto-scroll on new content
  // while this is true, so reading scrollback isn't yanked back down on every streamed token. A ref (not
  // state) so the scroll listener and the auto-scroll effect share the latest value without re-rendering.
  const stuckToBottom = useRef(true);
  // True while the pointer rests on interactive content — auto-scroll is suspended so the thing under the
  // cursor holds still. A ref (like `stuckToBottom`) so the effect reads it without re-rendering.
  const pointerHold = useRef(false);
  // A touch/wheel gesture (including inertial momentum) is in flight — while true, the auto-pin effect
  // must yield so an in-progress upward scroll is never yanked back to the tail.
  const userScrolling = useRef(false);
  const lastScrollTop = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drives the "Jump to latest" pill — shown only while scrolled up off the tail. Mirrors `stuckToBottom`
  // but as state, since visibility has to re-render (the ref intentionally doesn't).
  const [showJump, setShowJump] = useState(false);

  const IDLE_MS = 140;
  const settle = () => {
    userScrolling.current = false;
    onScroll(); // finalize "stuck" state from the resting position
  };
  const armSettle = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, IDLE_MS);
  };
  const markUserScroll = () => {
    userScrolling.current = true;
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  };

  // Within ~80px of the bottom counts as "stuck" so a tiny bit of slack (and sub-pixel rounding during
  // streaming) doesn't read as "scrolled up".
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    let stuck = distanceFromBottom < 80;
    if (userScrolling.current) {
      if (el.scrollTop < lastScrollTop.current - 1) stuck = false;
      armSettle();
    }
    lastScrollTop.current = el.scrollTop;
    stuckToBottom.current = stuck;
    setShowJump(!stuck);
  };

  const jumpToLatest = () => {
    userScrolling.current = false;
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    stuckToBottom.current = true;
    setShowJump(false);
    if (pin) pin();
    else endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };

  // Suspend/release the pointer hold. On RELEASE we re-run `onScroll` to refresh `stuckToBottom` from the
  // current position: if the tail streamed past the operator while paused, this reads as "scrolled up"
  // (the jump pill appears) instead of yanking to the bottom the moment the cursor leaves.
  const setHold = (hold: boolean) => {
    if (pointerHold.current === hold) return;
    pointerHold.current = hold;
    if (!hold) onScroll();
  };

  const onPointerOver = (e: React.PointerEvent) => {
    const target = e.target as Element | null;
    setHold(target?.closest?.(INTERACTIVE_SELECTOR) != null);
  };

  const onPointerLeave = () => setHold(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      markUserScroll();
      if (e.deltaY < 0) {
        stuckToBottom.current = false;
        setShowJump(true);
      }
      armSettle();
    };
    const onTouchStartMove = () => markUserScroll();
    const onTouchEnd = () => armSettle();
    const onScrollEnd = () => settle();
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStartMove, { passive: true });
    el.addEventListener("touchmove", onTouchStartMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("scrollend", onScrollEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStartMove);
      el.removeEventListener("touchmove", onTouchStartMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("scrollend", onScrollEnd);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers use only refs + stable setState; attach once
  }, []);

  useEffect(() => {
    if (!stuckToBottom.current || pointerHold.current || userScrolling.current) return;
    if (pin) pin();
    else endRef.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller (content signal)
  }, deps);

  return { scrollRef, endRef, showJump, jumpToLatest, onScroll, onPointerOver, onPointerLeave };
}

/**
 * The "Jump to latest" pill shown while scrolled up off the tail. Place it inside a `relative` ancestor of
 * the scroll container; pass `style` to control its vertical offset (e.g. above a floating composer).
 */
export function JumpToLatestButton({
  onClick,
  style,
  className = "",
}: {
  onClick: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Jump to latest"
      style={style}
      className={`absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1.5 pl-3 pr-3.5 text-[12px] text-dim shadow-md transition hover:text-text ${className}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 5v14" />
        <path d="M19 12l-7 7-7-7" />
      </svg>
      Jump to latest
    </button>
  );
}
