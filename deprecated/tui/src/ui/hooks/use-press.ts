import type { MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useRef } from "react";

/** What a pressable renderable listens to. Spread onto every line of the region a click acts on. */
export type PressHandlers = {
  onMouseDown?: (event: MouseEvent) => void;
  onMouseDrag?: (event: MouseEvent) => void;
  onMouseUp?: (event: MouseEvent) => void;
};

/**
 * A click, as press-and-release-in-the-same-cell — never as mouse-DOWN.
 *
 * ## Why this cannot be `onMouseDown`
 *
 * The renderer starts a text selection on mouse-down, before the handler runs and whatever the handler
 * does about it: `preventDefault()` is only consulted on the path where no selection began. The anchor
 * it takes is stored RELATIVE to the renderable under the pointer (`SelectionAnchor`), so it travels
 * with that renderable — and expanding a block reflows the transcript under a sticky scroll, which
 * moves every row. By the time the button comes up, the anchor has walked N rows away from a focus
 * point that never moved, and `finishSelection` settles the drag the user never made: the page lights
 * up selected and `useCopyOnSelect` puts it on the clipboard.
 *
 * Waiting for the release fixes it at the source — nothing reflows between the anchor being taken and
 * the selection being finished — and it buys the thing the old rule made impossible: a DRAG that starts
 * on a clickable row is now a drag. Press and release in one cell is a click; move at all and it is a
 * selection, so tool output can finally be highlighted and copied.
 *
 * The press is then cleared, because a click IS how you dismiss a selection and the empty one left over
 * from the anchor would otherwise linger with a live anchor inside a block that is about to move.
 *
 * ## One press per REGION
 *
 * The returned factory closes over a single origin, so a region whose lines are separate renderables
 * still behaves as one target: whichever line takes the release checks it against the press that any
 * line of the region took. Nested regions (`ToolDetail`'s `… +N lines` inside a call's body) share the
 * caller's factory for the same reason, and the inner one stops the release from bubbling — otherwise
 * opening the rest of the output would collapse the call it belongs to in the same gesture.
 */
export function usePress(): (onPress?: () => void) => PressHandlers {
  const renderer = useRenderer();
  const origin = useRef<{ x: number; y: number } | null>(null);

  return (onPress) => {
    // No handlers at all rather than dead ones: a listener that does nothing still swallows the
    // release from a region further out that would have acted on it.
    if (onPress === undefined) return {};
    return {
      onMouseDown: (event) => {
        origin.current = { x: event.x, y: event.y };
      },
      // A drag out of the cell is a selection, and a selection is not a click. Dropped here as well as
      // checked on release, so an origin cannot outlive the gesture that took it.
      onMouseDrag: (event) => {
        const start = origin.current;
        if (start && (start.x !== event.x || start.y !== event.y)) origin.current = null;
      },
      onMouseUp: (event) => {
        const start = origin.current;
        origin.current = null;
        if (start === null || start.x !== event.x || start.y !== event.y) return;
        event.stopPropagation();
        renderer.clearSelection();
        onPress();
      },
    };
  };
}
