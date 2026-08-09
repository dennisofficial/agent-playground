import React, { useRef, useState } from "react";
import { theme } from "../theme.js";
import { useWheelAxis } from "./wheel-axis.js";

type Pannable = { scrollX: number; maxScrollX: number };

export function TextPanner(props: {
  /** The content's natural width — what it would need to be shown whole. */
  columns: number;
  /** The width actually available, which the child is sized to. */
  width: number;
  /** Height of the content, WITHOUT the scrollbar row this adds. */
  rows: number;
  /** A single element backed by a text buffer. See `Pannable`. */
  children: React.ReactElement;
}): React.ReactNode {
  const child = useRef<Pannable | null>(null);
  const [offset, setOffset] = useState(0);

  const onWheel = useWheelAxis({
    canPan: () => (child.current?.maxScrollX ?? 0) > 0,
    pan: (sideways, event) => {
      const node = child.current;
      if (!node) return;
      // A horizontal report over the BUFFER ITSELF has already moved it by the time this runs: mouse
      // events reach the deepest renderable first, and `TextBufferRenderable` maps left/right onto
      // its own `scrollX`, one column per report. Applying it again would double every report.
      // Everything else has to be applied here — the modifier spellings, which the buffer ignores
      // entirely, and any report that landed on the scrollbar row rather than on the code.
      const moved =
        sideways.source === "wheel" &&
        event.target === (node as unknown as object);
      if (!moved) node.scrollX += sideways.direction === "left" ? -1 : 1;
      setOffset(node.scrollX);
    },
  });

  return (
    // The height counts the scrollbar row, so the bar sits BELOW the content rather than on its
    // last line — the same accounting the scrollbox used to do inside itself.
    <box
      flexDirection="column"
      width={props.width}
      height={props.rows + 1}
      flexShrink={0}
      onMouseScroll={onWheel}
    >
      {React.cloneElement(props.children, { ref: child } as Partial<unknown>)}
      <ScrollBar
        columns={props.columns}
        width={props.width}
        offset={offset}
        onSeek={(column) => {
          const node = child.current;
          if (!node) return;
          node.scrollX = column;
          setOffset(node.scrollX);
        }}
      />
    </box>
  );
}

function ScrollBar(props: {
  columns: number;
  width: number;
  offset: number;
  onSeek: (column: number) => void;
}): React.ReactNode {
  const bar = useRef<{ x: number } | null>(null);
  /** Where in the thumb it was grabbed, so a drag does not jerk it to centre on the first report. */
  const grab = useRef<number | null>(null);
  const thumb = Math.max(
    1,
    Math.min(
      props.width,
      Math.round((props.width * props.width) / props.columns),
    ),
  );
  const travel = props.width - thumb;
  const span = Math.max(1, props.columns - props.width);
  const before = Math.max(
    0,
    Math.min(travel, Math.round((props.offset / span) * travel)),
  );

  /** Absolute screen column → the thumb's left edge → a content column. */
  const seekTo = (screenX: number, offsetInThumb: number): void => {
    // Read off the renderable, not the layout: a mouse event carries absolute screen columns, and
    // the bar's own left edge moves every time the transcript scrolls under it.
    const local = screenX - (bar.current?.x ?? 0);
    const placed = Math.max(0, Math.min(travel, local - offsetInThumb));
    props.onSeek(travel === 0 ? 0 : Math.round((placed / travel) * span));
  };

  return (
    <box
      ref={bar as never}
      flexDirection="row"
      width={props.width}
      height={1}
      onMouseDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        const local = event.x - (bar.current?.x ?? 0);
        const onThumb = local >= before && local < before + thumb;
        // Grabbing the thumb keeps the point you took hold of; clicking the track jumps there and
        // then behaves as though you had grabbed the thumb's middle.
        grab.current = onThumb ? local - before : Math.floor(thumb / 2);
        seekTo(event.x, grab.current);
      }}
      onMouseDrag={(event) => {
        if (grab.current === null) return;
        event.stopPropagation();
        seekTo(event.x, grab.current);
      }}
      onMouseUp={() => {
        grab.current = null;
      }}
    >
      {before > 0 ? (
        <text fg={theme.dim} selectable={false}>
          {"─".repeat(before)}
        </text>
      ) : null}
      <text selectable={false}>{"━".repeat(thumb)}</text>
      {travel - before > 0 ? (
        <text fg={theme.dim} selectable={false}>
          {"─".repeat(travel - before)}
        </text>
      ) : null}
    </box>
  );
}
