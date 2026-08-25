import type { ScrollBoxRenderable } from "@opentui/core";
import React, { useRef } from "react";
import { theme } from "../theme.js";
import { useWheelAxis } from "./wheel-axis.js";

/** Rows the horizontal scrollbar takes from the content once the block can scroll. */
const SCROLLBAR = 1;

export function HorizontalScroller(props: {
  /** Height of the content, WITHOUT the scrollbar row this adds. */
  rows: number;
  children: React.ReactNode;
}): React.ReactNode {
  const scroller = useRef<ScrollBoxRenderable>(null);

  const onWheel = useWheelAxis({
    canPan: () => {
      const box = scroller.current;
      return box ? box.scrollWidth > box.viewport.width : false;
    },
    pan: (sideways) => {
      const box = scroller.current;
      // OpenTUI's scrollbox pans ITSELF for two of the three spellings — a horizontal report and
      // shift+wheel — one column at a time, on this same renderable right after this listener runs.
      // Panning those here as well moved the block twice per report, which is what made a swipe
      // lurch instead of scroll. Alt is ours alone: the scrollbox knows nothing about it, and it is
      // the only spelling some terminals deliver at all.
      if (!box || sideways.source !== "alt") return;
      box.scrollBy({ x: sideways.direction === "left" ? -1 : 1, y: 0 });
    },
  });

  return (
    // The height counts the scrollbar row: a scrollbox draws its horizontal bar INSIDE its own
    // height, so at `rows` the bar would sit on top of the content's last line.
    <scrollbox
      ref={scroller}
      scrollX
      scrollY={false}
      flexShrink={0}
      height={props.rows + SCROLLBAR}
      onMouseScroll={onWheel}
      // Chrome, not content: the bar says where you are in the block, so it is dimmed like every
      // other structural marker in the transcript. Arrows are dropped — nothing clicks them, and
      // two of the block's precious columns are better spent on the block.
      horizontalScrollbarOptions={{
        showArrows: false,
        trackOptions: { foregroundColor: theme.dim },
      }}
    >
      {props.children}
    </scrollbox>
  );
}
