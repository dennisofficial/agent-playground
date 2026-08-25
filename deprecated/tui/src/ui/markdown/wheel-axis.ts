import type { MouseEvent } from "@opentui/core";
import { useRef } from "react";

const AXIS_LOCK_MS = 300;

/** What made a report sideways — which decides who, if anyone, has already acted on it. */
export type Sideways = {
  direction: "left" | "right";
  /** `wheel` is the terminal's own horizontal report; the others are a modifier over up/down. */
  source: "wheel" | "shift" | "alt";
};

export function useWheelAxis(opts: {
  /** Whether the block has anywhere to pan right now. */
  canPan: () => boolean;
  /** Move the block one report's worth. Not called for a plain vertical wheel. */
  pan: (sideways: Sideways, event: MouseEvent) => void;
}): (event: MouseEvent) => void {
  /** When this block last saw a sideways report. See `AXIS_LOCK_MS`. */
  const pannedAt = useRef(0);

  return (event: MouseEvent): void => {
    if (!opts.canPan()) return;

    const sideways = readSideways(event);
    if (sideways) {
      pannedAt.current = Date.now();
      opts.pan(sideways, event);
      // The transcript cannot use a sideways report anyway, but stopping here keeps its scroll
      // accumulator from collecting fractions of a row it will never spend.
      event.stopPropagation();
      return;
    }

    // Vertical, in the tail of a pan: swallowed, so the page holds still.
    if (Date.now() - pannedAt.current < AXIS_LOCK_MS) event.stopPropagation();

    // Vertical, on its own: left alone entirely, so it bubbles to the transcript.
  };
}

function readSideways(event: MouseEvent): Sideways | null {
  const wheel = event.scroll?.direction;
  if (wheel === "left" || wheel === "right")
    return { direction: wheel, source: "wheel" };
  if (wheel !== "up" && wheel !== "down") return null;

  // Up is RIGHT and down is left: the viewport chases the wheel, so scrolling "down" the block walks
  // back towards its start the way scrolling down a page walks towards its end. This is the opposite
  // of how OpenTUI's scrollbox maps shift, and deliberately so — that mapping moves the content with
  // the fingers, which reads as backwards when the fingers are moving on a vertical axis and the
  // block is moving on a horizontal one. A literal left/right report is NOT flipped: the terminal
  // named a direction there, and it is the same direction the text buffer will act on itself.
  const direction = wheel === "up" ? "right" : "left";
  if (event.modifiers.alt) return { direction, source: "alt" };
  if (event.modifiers.shift) return { direction, source: "shift" };
  return null;
}
