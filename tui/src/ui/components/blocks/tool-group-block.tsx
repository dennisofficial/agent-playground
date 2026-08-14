import { TextAttributes } from "@opentui/core";
import React, { useState } from "react";
import {
  GROUP_GAP,
  groupLayout,
  rowLabel,
  rowNote,
  rowVerb,
} from "../../../domain/group-layout.js";
import {
  EHit,
  groupHeadline,
  hitKey,
  visibleRows,
  type GroupMember,
  type ToolGroup,
} from "../../../domain/tool-group.js";
import { usePress } from "../../hooks/use-press.js";
import { glyph, theme, TRANSCRIPT_INSET } from "../../theme.js";
import { ToolDetail, type DetailInteraction } from "./tool-detail.js";

/** What a group sizes itself to when drawn outside a measured transcript (tests). */
const DEFAULT_WIDTH = 80;

/**
 * A run of adjacent gathering calls, drawn as one block.
 *
 * ## The interaction rule
 *
 * **Every line of a thing is part of that thing.** Click a summary to open it, click ANYWHERE in it to
 * close it — you never scroll back to the header you opened it from. Hover follows the same regions,
 * so the wash lights exactly what a click is about to collapse: pointing at the heading lights the
 * whole block, pointing at a row lights that row and its body.
 *
 * The row is the click target rather than a glyph, because a one-cell `▶` is hard to hit and the row
 * already reads as one thing. Hover changes COLOUR only — never text, never width. A `click to expand`
 * label that appeared under the pointer would reflow the thing being pointed at, which is the lesson
 * `markdown/copy-button.tsx` already carries.
 *
 * A click is press-and-release in the same cell — see `usePress`. Opening a block reflows everything
 * under it, and acting on the mouse-DOWN left the renderer holding a selection anchor inside the rows
 * that were about to move.
 *
 * ## Wide content
 *
 * Every row is `wrapMode="none"` over a hard-clipped label, because a group's rows are a TABLE and a
 * wrapped cell stops being a column. Prose — an opened call's output, an error — wraps instead; see
 * `ToolDetail` and `wrapWords`.
 */
export function ToolGroupBlock(props: {
  group: ToolGroup;
  /** The transcript's reading width, so rows can size their columns and clip. */
  width?: number;
  /** Calls with no result yet. Empty outside a running turn. */
  running?: ReadonlySet<string>;
  /** The transcript's ONE expansion set, keyed by `hitKey`. */
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  frame?: string;
  elapsed?: string;
}): React.ReactNode {
  // Hover is local to the block: it is a pointer position, not state anybody else can act on, and
  // lifting it to the page would re-render every other block on every mouse move.
  const [hovered, setHovered] = useState<string | null>(null);

  const running = props.running ?? EMPTY;
  const groupKey = hitKey(EHit.group, props.group.id);
  const open = props.expanded.has(groupKey);
  const inner = Math.max(24, (props.width ?? DEFAULT_WIDTH) - TRANSCRIPT_INSET);

  const { shown, earlier } = visibleRows({ members: props.group.members, open });
  // Measured over EVERY member and with the spinner's width reserved, so the columns do not slide as
  // the group streams — see `groupLayout`.
  const layout = groupLayout({ members: props.group.members, width: inner, running });
  const headline = groupHeadline({ group: props.group, running, width: inner });

  const lit = (key: string): boolean => hovered === groupKey || hovered === key;
  const wash = (key: string): { bg?: string } => (lit(key) ? { bg: theme.hoverBg } : {});
  /**
   * Spaces out to the right margin, so the wash runs the FULL row.
   *
   * A row's three columns already fill `inner` exactly, but the heading and the elision marker are
   * shorter than the line — and a highlight that stops where the text stops reads as a selection of
   * the words rather than of the row, which is not what a click acts on.
   */
  const fill = (used: number): string => " ".repeat(Math.max(0, inner - used));
  // One press origin for the whole block, so a release anywhere in a region is measured against the
  // press that any of its lines took — and so the body's own targets nest inside the row's.
  const press = usePress();
  const handlers = (key: string) => ({
    ...press(() => props.onToggle(key)),
    onMouseOver: () => setHovered(key),
    onMouseOut: () => setHovered((current) => (current === key ? null : current)),
  });
  // One pointer position for the whole block, handed to the bodies. Two components tracking hover
  // separately would let a row and its own body light up independently.
  const detailUi: DetailInteraction = {
    hovered,
    setHovered,
    onToggle: props.onToggle,
    expanded: props.expanded,
    press,
  };

  return (
    <box flexDirection="column" marginBottom={1}>
      {/* `width` as well as `wrapMode`, because a heading that crosses the margin costs the block a
          whole extra ROW and jumps every line below it — and the heading GROWS while a turn runs.
          `groupHeadline` reserves the suffix and clips the sentence so the row count never changes. */}
      <text wrapMode="none" width={inner} flexShrink={0} {...handlers(groupKey)}>
        {/* The gutter says whether the group is still happening, and whether it is open. */}
        <span fg={headline.live > 0 ? theme.accent : theme.dim} {...wash(groupKey)}>
          {headline.live > 0 ? `${props.frame ?? "⠋"} ` : earlier > 0 ? "▶ " : "▼ "}
        </span>
        <span attributes={TextAttributes.BOLD} {...wash(groupKey)}>
          {headline.title}
        </span>
        {headline.suffix.length > 0 ? (
          <span fg={theme.accent} {...wash(groupKey)}>
            {headline.suffix}
          </span>
        ) : null}
        <span {...wash(groupKey)}>
          {fill(2 + headline.title.length + headline.suffix.length)}
        </span>
      </text>

      {/* Always ABOVE the rows and always saying `earlier`, because the window is always the tail —
          see `visibleRows`. It takes the `⎿` when it is present, so the block's gutter anchor sits at
          the start of the result region wherever that region starts. */}
      {earlier > 0 ? (
        <text wrapMode="none" width={inner} flexShrink={0} {...handlers(groupKey)}>
          <span fg={theme.dim} {...wash(groupKey)}>
            {`  ${glyph.result}  … +${earlier} earlier`}
          </span>
          <span {...wash(groupKey)}>{fill(5 + `… +${earlier} earlier`.length)}</span>
        </text>
      ) : null}

      {shown.map((member, index) => {
        const key = hitKey(EHit.call, member.payload.toolUseId);
        const isLive = running.has(member.payload.toolUseId);
        const row = member.view.row;
        return (
          <box key={key} flexDirection="column">
            <text wrapMode="none" width={inner} flexShrink={0} {...handlers(key)}>
              <span fg={theme.dim} {...wash(key)}>
                {index === 0 && earlier === 0 ? `  ${glyph.result}  ` : "     "}
              </span>
              {layout.verb > 0 ? (
                <span fg={theme.dim} {...wash(key)}>
                  {rowVerb(member, layout)}
                </span>
              ) : null}
              <span {...(row.ok ? {} : { fg: theme.error })} {...wash(key)}>
                {rowLabel(row, layout)}
              </span>
              <span fg={isLive ? theme.accent : theme.dim} {...wash(key)}>
                {isLive
                  ? " ".repeat(GROUP_GAP) +
                    `${props.frame ?? "⠋"} ${props.elapsed ?? ""}`.padStart(layout.note)
                  : rowNote(row, layout)}
              </span>
            </text>
            {props.expanded.has(key) ? (
              <box flexDirection="column" {...handlers(key)}>
                <ToolDetail member={member} width={inner} ui={detailUi} />
              </box>
            ) : null}
          </box>
        );
      })}

    </box>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/** Every key a group offers `x` / `X`, in the order the reader sees them. */
export function groupExpandKeys(group: ToolGroup): string[] {
  return [
    hitKey(EHit.group, group.id),
    ...group.members.map((member: GroupMember) => hitKey(EHit.call, member.payload.toolUseId)),
  ];
}
