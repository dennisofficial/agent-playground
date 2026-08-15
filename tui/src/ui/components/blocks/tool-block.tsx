import { TextAttributes } from "@opentui/core";
import React from "react";
import {
  delegateGist,
  delegateMeasure,
  delegateName,
} from "../../../domain/delegate-view.js";
import type { Delegate } from "../../../domain/delegates.js";
import { EDelegateStatus } from "../../../domain/message.js";
import {
  beaconHeat,
  shimmerCrest,
  WORKING_SHIMMER,
} from "../../../domain/shimmer.js";
import type { DiffHunk } from "../../../domain/tool-diff.js";
import { useClickRegion } from "../../hooks/use-click-region.js";
import { useShimmerClock } from "../../hooks/use-conversation.js";
import { beaconColour, shimmerSpans } from "../../shimmer-style.js";
import { glyph, spinnerFrame, theme, TRANSCRIPT_INSET } from "../../theme.js";
import { CommandLines } from "./tool-detail.js";
import { DiffView } from "./diff-view.js";

/** What a diff sizes itself to when the block is drawn outside a measured transcript (tests). */
const DEFAULT_WIDTH = 80;

export function ToolBlock(props: {
  name: string;
  toolUseId: string;
  target?: string;
  /**
   * A Bash command in full. The header carries the model's DESCRIPTION instead, so without this the
   * command would be nowhere — see `ToolView.command`.
   */
  command?: readonly string[];
  result?: {
    ok: boolean;
    summary: string;
    detail: string[];
    diff?: DiffHunk[];
  };
  /** The transcript's reading width, so a diff can size its gutter and clip its rows. */
  width?: number;
  expanded?: boolean;
  onToggle?: (toolUseId: string) => void;
  /**
   * The run this call SPAWNED, when it spawned one. Live only, and deliberately: a delegate's own
   * calls are never written into this thread, so between the call and its result these two lines are
   * the whole account of what is happening — and once the result lands, the result IS the account and
   * these fall back to a measure of what it cost.
   */
  delegate?: Delegate;
  /** The clock these lines count against. The page already ticks one; this borrows it. */
  now?: number;
}): React.ReactNode {
  // A command counts as detail even when the tool said nothing back: `Bash(List sources)` with no
  // output still has something worth opening, namely which command that description stood for.
  const hasDetail =
    (props.result && props.result.detail.length > 0) || (props.command?.length ?? 0) > 0;
  // Clickable, and it had to become so: `x` / `X` used to be the only way to open this, and they never
  // could work — the composer takes first refusal on every key and consumes printable characters, so
  // those branches were unreachable. See `useClickRegion` for the rule they are replaced by.
  const toggle = props.onToggle;
  const { handlers, wash } = useClickRegion(
    hasDetail && toggle ? () => toggle(props.toolUseId) : undefined,
  );
  // No disclosure triangle. Every tool call in the transcript carried one, which made a column of
  // `▶` the most repeated glyph on screen — and it was pointing at something the reader already had
  // two better cues for: `useClickRegion`'s hover wash says the row acts on a click, and an open
  // block is self-evidently open because its detail is underneath it. The two columns stay so the
  // `⎿` result line below still hangs off the same left edge.
  const gutter = "  ";
  // A diff shows without being asked. It is the answer to "what did that edit do?", which is a
  // question the reader always has and the summary line structurally cannot answer; every other
  // kind of tool detail is output they can go and look at if they want it.
  const diff = props.result?.diff;

  return (
    <box flexDirection="column" marginBottom={1}>
      <text wrapMode="none" {...handlers}>
        <span {...wash}>{gutter}</span>
        <span attributes={TextAttributes.BOLD} {...wash}>
          {props.name}
        </span>
        {props.target ? <span {...wash}>({props.target})</span> : null}
      </text>
      {props.delegate ? (
        <DelegateLines delegate={props.delegate} now={props.now ?? 0} />
      ) : null}
      {props.result ? (
        <box flexDirection="column" {...handlers}>
          <text>
            {"  "}
            <span fg={theme.dim}>{glyph.result}</span>
            {"  "}
            <span fg={props.result.ok ? undefined : theme.error}>
              {props.result.summary}
            </span>
          </text>
          {/* Above the output, and highlighted as bash — a shell shows you the command, then what it
              said. See `CommandLines`. */}
          {props.expanded && props.command && props.command.length > 0 ? (
            <CommandLines
              command={props.command}
              width={(props.width ?? DEFAULT_WIDTH) - TRANSCRIPT_INSET}
            />
          ) : null}
          {diff && diff.length > 0 ? (
            <DiffView
              hunks={diff}
              width={props.width ?? DEFAULT_WIDTH}
              expanded={props.expanded ?? false}
              // For a file-editing tool the target IS the path — `toolTarget` returns it, relativised,
              // before it considers any other argument. So the language comes for free, with no new
              // field threaded down from the engine.
              path={props.target}
            />
          ) : props.expanded ? (
            props.result.detail.map((line, index) => (
              <text key={index} fg={theme.dim}>
                {"     "}
                {line}
              </text>
            ))
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

/**
 * A delegate's two lines, under the call that spawned it.
 *
 * The `⋮` gutter rather than the `⎿` a result uses, because these are NOT the result: they are the run
 * still happening, and the reader has to be able to tell at a glance which of the two they are looking
 * at when both are on screen.
 *
 * **Running and finished must not look the same.** They did, at first — two Agent blocks side by side,
 * both dim, both reading `54 tools · 8m 24s`, and the only difference between the one still working and
 * the one that had already answered was whether a result line happened to be below it. So a running
 * delegate takes the SAME sweep the working line uses: the identical `WORKING_SHIMMER` rhythm, a
 * spinner in its gutter, one visual language for "something is alive here" wherever it appears. A
 * finished one goes flat and dim, and a failed one keeps its gutter marked in red.
 */
function DelegateLines(props: {
  delegate: Delegate;
  now: number;
}): React.ReactNode {
  const running = props.delegate.status === EDelegateStatus.running;
  // A clock per running delegate, and only while it runs. A settled row subscribes to nothing, which
  // is what keeps a transcript full of finished delegates from ticking at 25fps.
  const clock = useShimmerClock(running);
  const gist = delegateGist(props.delegate);
  const label = `${delegateName(props.delegate)} · ${delegateMeasure(props.delegate, props.now)}`;
  const failed = props.delegate.status !== EDelegateStatus.completed && !running;

  return (
    <box flexDirection="column">
      {running ? (
        <SweepingLine label={label} now={clock} />
      ) : (
        <text fg={theme.dim} wrapMode="none">
          <span fg={failed ? theme.error : theme.dim}>
            {"  "}
            {failed ? glyph.failed : "⋮"}{" "}
          </span>
          {label}
        </text>
      )}
      {gist ? (
        <text fg={theme.dim} wrapMode="none">
          {"  ⋮ "}
          {gist}
        </text>
      ) : null}
    </box>
  );
}

/**
 * The lit measure line. Two columns of indent, the spinner, a space, then the label — so the crest is
 * measured across the whole strip and does not appear a word in from nowhere. Same arithmetic as
 * `WorkingLine`; deliberately not shared with it, because that one owns column 0 of the transcript and
 * this one is indented under a block, and the offset is the only thing that differs.
 */
function SweepingLine(props: { label: string; now: number }): React.ReactNode {
  const TEXT_OFFSET = 4;
  const cells = [...props.label].length + TEXT_OFFSET;
  const crest = shimmerCrest(props.now, cells, WORKING_SHIMMER);

  return (
    <text wrapMode="none">
      {"  "}
      <span fg={beaconColour(beaconHeat(crest, WORKING_SHIMMER))}>
        {spinnerFrame(props.now)}
      </span>
      <span> </span>
      {shimmerSpans(props.label, crest, WORKING_SHIMMER, TEXT_OFFSET).map(
        (span, index) => (
          <span key={index} fg={span.fg}>
            {span.text}
          </span>
        ),
      )}
    </text>
  );
}
