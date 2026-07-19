import { useEffect, useRef } from 'react';
import { useReviewComments } from '../review-comments';

/**
 * Detect a completed text selection inside `containerRef` and hand it off to `onSelect`. Used only on the
 * commentable detail-pane views (spec/generated/artifact files, plan, decision, diff) — `active` gates it
 * off elsewhere so selecting text in a transcript/port/subagent view never opens the comment popover.
 */
export function useTextSelection({
  containerRef,
  active,
  onSelect,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  active: boolean;
  onSelect: (sel: { quote: string; rect: DOMRect; range: Range }) => void;
}) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    function onMouseUp() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!container || !container.contains(range.commonAncestorContainer)) return;
      const quote = sel.toString().replace(/\s+/g, ' ').trim();
      if (quote.length < 2) return;
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      onSelect({ quote, rect, range: range.cloneRange() });
    }

    // `mouseup` covers drag-to-select; `selectionchange` also fires for keyboard-driven selection
    // (Shift+Arrow) but far more often (every caret move), so it's deliberately NOT wired here — the
    // mockup's interaction is mouse-drag select, and mouseup alone keeps this cheap and predictable.
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [active, containerRef, onSelect]);
}

/**
 * The wiring every commentable detail view needs: a ref to attach to its content wrapper (`FileView`,
 * `PlanDoc`, `DecisionDoc`, `DiffView` each own their own scroller — there's no single shared container in
 * `PhaseView` to hook once) + the selection listener that begins a pending comment on the shared context.
 * Non-commentable views (ports, subagents, transcripts) simply never call this.
 */
export function useCommentableRef<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  const { beginPending } = useReviewComments();
  useTextSelection({ containerRef: ref, active: true, onSelect: beginPending });
  return ref;
}
