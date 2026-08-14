import { useState } from "react";
import { theme } from "../theme.js";
import { usePress, type PressHandlers } from "./use-press.js";

/**
 * A block that opens and closes under the pointer.
 *
 * The interaction rule, in one place: **click a summary to open it, click anywhere in it to close it.**
 * So the handlers go on every line of the region, not just its header, and hover lights all of them —
 * what is lit is what a click is about to collapse.
 *
 * A click is press-and-release in one cell, not mouse-down; `usePress` carries why, and it is the whole
 * reason expanding a block no longer leaves the transcript looking dragged-over.
 *
 * Hover state is LOCAL to the block. It is a pointer position, not something anybody else acts on, and
 * lifting it to the page would re-render every other block in the transcript on every mouse move.
 *
 * `undefined` for `onToggle` means the block is not clickable — the live tail has nothing to key an
 * expansion on — and then no handlers are attached at all rather than dead ones that swallow the event.
 */
export function useClickRegion(onToggle?: () => void): {
  hovered: boolean;
  handlers: PressHandlers & {
    onMouseOver?: () => void;
    onMouseOut?: () => void;
  };
  /** Spread onto every `<span>` of the region. Colour only — see below. */
  wash: { bg?: string };
} {
  const [hovered, setHovered] = useState(false);
  const press = usePress();
  if (onToggle === undefined) return { hovered: false, handlers: {}, wash: {} };
  return {
    hovered,
    handlers: {
      ...press(onToggle),
      onMouseOver: () => setHovered(true),
      onMouseOut: () => setHovered(false),
    },
    // Hover changes COLOUR only — never text, never width. A label that appears under the pointer
    // reflows the thing being pointed at, which is the lesson `markdown/copy-button.tsx` carries.
    wash: hovered ? { bg: theme.hoverBg } : {},
  };
}
