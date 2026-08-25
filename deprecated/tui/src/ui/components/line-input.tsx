import type { BoxRenderable, MouseEvent } from "@opentui/core";
import React, { useMemo, useRef, useState } from "react";
import { indexAt, layoutComposer } from "../../domain/composer-layout.js";
import { EMPTY_EDITOR, type EditorState } from "../../domain/text-editor.js";
import { useCopyNotice } from "../copy-on-select.js";
import { theme } from "../theme.js";

/**
 * The one-line box a list page borrows its footer for — a filter, a job's new name, an OAuth code.
 *
 * This is the composer Atlas shipped first, kept for the inputs it is still right for. It draws over
 * the pure `domain/` editor, and its caret moves over LOGICAL lines: correct here, because none of
 * these inputs has a second line to move to. `↑`/`↓` are refused outright and reach the list behind
 * the box, which is the whole reason these pages can filter and navigate with one keyboard.
 *
 * The prompt composer is `composer.tsx` and shares nothing with this: it is the native editor, and it
 * moves over the rows the user can SEE, because a draft wraps and a filter does not. Two components
 * because they answer to two different keyboards, not because one is a leftover.
 */

/** A path or a long job name can wrap; nothing here ever gets close to eight rows of it. */
const DEFAULT_MAX_ROWS = 8;

export function LineInput(props: {
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
