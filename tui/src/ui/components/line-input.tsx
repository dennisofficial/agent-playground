import type { BoxRenderable, MouseEvent } from "@opentui/core";
import React, { useMemo, useRef, useState } from "react";
import { indexAt, layoutComposer } from "../../domain/composer-layout.js";
import { EMPTY_EDITOR, type EditorState } from "../../domain/text-editor.js";
import { useCopyNotice } from "../copy-on-select.js";
import { theme } from "../theme.js";

const DEFAULT_MAX_ROWS = 8;

export function composerRows(height: number): number {
  return Math.max(DEFAULT_MAX_ROWS, Math.floor(height / 2) - 2);
}

export function Composer(props: {
  state?: EditorState;
  value?: string;
  placeholder?: string;
  width: number;
  maxRows?: number;
  focused?: boolean;
  onCaret?: (index: number) => void;
}): React.ReactNode {
  const fallback = useMemo(
    () => fallbackState(props.value ?? ""),
    [props.value],
  );
  const state = props.state ?? fallback;
  const copied = useCopyNotice();

  // Where the window is parked. State rather than a ref because the wheel has to repaint, and a
  // scroll changes nothing else on the page that would.
  const [top, setTop] = useState(0);

  const seen = useRef<EditorState | null>(null);
  const revealCaret = seen.current !== state;
  seen.current = state;

  // Two border columns, two padding columns, and the two-column `> ` gutter.
  const textWidth = Math.max(8, props.width - 6);
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS;
  const layout = layoutComposer(state, textWidth, maxRows, {
    top,
    revealCaret,
  });
  const showCaret = props.focused !== false;
  const isEmpty = state.text.length === 0;

  if (layout.hiddenAbove !== top) setTop(layout.hiddenAbove);

  const onWheel = (event: MouseEvent): void => {
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    setTop((current) => Math.max(0, current + (direction === "up" ? -1 : 1)));
  };

  const box = useRef<BoxRenderable | null>(null);
  const onPress = (event: MouseEvent): void => {
    if (!props.onCaret) return;
    const origin = box.current;
    if (!origin) return;

    const row = event.y - origin.y - 1;
    const column = event.x - origin.x - 1 - 1 - 2;
    // Above the first row or below the last is the border itself — a click there is on the box, not on
    // the text, and moving the caret to the nearest end would be a guess the user did not ask for.
    if (row < 0 || row >= layout.rows.length) return;

    props.onCaret(indexAt(layout, row, column));
  };

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      borderStyle="rounded"
      borderColor={theme.dim}
      paddingX={1}
      {...(copied
        ? {
            title: ` ${copied.text} `,
            titleColor: copied.ok ? theme.okBright : theme.warn,
          }
        : {})}
      titleAlignment="right"
      onMouseScroll={onWheel}
      onMouseDown={onPress}
      ref={box as never}
    >
      {layout.rows.map((row, index) => (
        <text key={index}>
          {index === 0 ? <span fg={theme.dim}>{"> "}</span> : "  "}
          {isEmpty && props.placeholder ? (
            <>
              {showCaret ? (
                <Caret character={props.placeholder.slice(0, 1)} />
              ) : null}
              <span fg={theme.dim}>
                {props.placeholder.slice(showCaret ? 1 : 0)}
              </span>
            </>
          ) : (
            <Row text={row.text} caret={showCaret ? row.caret : null} />
          )}
        </text>
      ))}

      {/* A draft taller than the composer must say so, or the missing lines read as lost text. */}
      {layout.hiddenAbove > 0 || layout.hiddenBelow > 0 ? (
        <text fg={theme.dim}>
          {"  "}
          {layout.hiddenAbove > 0 ? `↑ ${layout.hiddenAbove} more` : ""}
          {layout.hiddenAbove > 0 && layout.hiddenBelow > 0 ? " · " : ""}
          {layout.hiddenBelow > 0 ? `↓ ${layout.hiddenBelow} more` : ""}
        </text>
      ) : null}
    </box>
  );
}

function Row(props: { text: string; caret: number | null }): React.ReactNode {
  if (props.caret === null) return <span>{props.text}</span>;

  const before = props.text.slice(0, props.caret);
  const under = props.text.slice(props.caret, props.caret + 1);
  const after = props.text.slice(props.caret + 1);

  return (
    <>
      <span>{before}</span>
      <Caret character={under} />
      <span>{after}</span>
    </>
  );
}

function Caret(props: { character: string }): React.ReactNode {
  return (
    <span bg={theme.caretBg} fg={theme.caretFg}>
      {props.character.length > 0 ? props.character : " "}
    </span>
  );
}

function fallbackState(value: string): EditorState {
  return value.length === 0
    ? EMPTY_EDITOR
    : { text: value, cursor: value.length, goalColumn: null };
}
