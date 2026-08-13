import React from "react";
import type { QueuedSteer } from "../../app/conversation.store.js";
import {
  beaconHeat,
  shimmerCrest,
  WORKING_SHIMMER,
} from "../../domain/shimmer.js";
import { useShimmerClock } from "../hooks/use-conversation.js";
import { beaconColour, shimmerSpans } from "../shimmer-style.js";
import {
  formatElapsed,
  formatTokens,
  glyph,
  spinnerFrame,
  theme,
} from "../theme.js";

/**
 * The only place the transcript admits a turn is in flight — so it has to carry from across the
 * room, not just from reading distance.
 *
 * It does that with two rhythms rather than one. The spinner in column 0 is the fast channel: it
 * says "right now", and it is the thing that stops the instant the turn does. The sweep is the slow
 * one: a crest of light crosses the whole sentence, rests, and comes back ~2.5s later, which is
 * motion the width of the line rather than motion the width of a cursor. The icon is where the
 * light leaves from — it flares as the crest departs and never on the return, so the two read as
 * one gesture instead of two things blinking near each other.
 *
 * Both are pure functions of the wall clock (`domain/shimmer.ts`), so there is no animation state
 * here and no frame that can be missed; a render at any instant draws that instant.
 */
export function WorkingLine(props: {
  running: boolean;
  elapsedMs: number;
  frame: string;
  outputTokens: number;
  queued: QueuedSteer[];
  interrupting: boolean;
  /**
   * The model has stopped but the session is held open for a backgrounded delegate. A third state,
   * not a flavour of `running`: shimmering over a session where nothing is being written reads as an
   * agent that has hung, and it is the one reading this line must never give.
   */
  holding?: boolean;
}): React.ReactNode {
  // The line's own clock, faster than the page's and only while the sweep is actually on screen. Both
  // interrupting and holding are different states with different animations, so neither pays for it.
  const shimmering = props.running && !props.interrupting && !props.holding;
  const now = useShimmerClock(shimmering);

  const elapsed = formatElapsed(props.elapsedMs);
  // ↓, not ↑: this counts what came DOWN from the model. Up is what we sent it.
  const tokens =
    props.outputTokens > 0
      ? `↓ ${formatTokens(props.outputTokens)} tokens`
      : "";
  // Running, the parenthetical always has the escape hatch in it; finished, it is tokens or nothing.
  const detail = props.running
    ? `${tokens ? `${tokens} · ` : ""}esc to interrupt`
    : tokens;

  // Held, the line stops claiming the model is doing anything. It says what the session is actually
  // waiting for, and keeps the escape hatch — `esc` is how you stop waiting, and the delegates with it.
  const label = props.holding
    ? `Waiting on background work — ${elapsed} (esc to stop)`
    : `${props.running ? "Working" : "Worked"} for ${elapsed}${detail ? ` (${detail})` : ""}`;

  return (
    <box flexDirection="column">
      {shimmering ? (
        <ShimmeringLine label={label} now={now} />
      ) : (
        <text fg={theme.dim}>
          <span fg={props.interrupting ? theme.accent : theme.dim}>
            {props.interrupting ? props.frame : glyph.thinking}
          </span>{" "}
          {props.interrupting ? "Interrupting…" : label}
        </text>
      )}
      {props.queued.map((steer) => (
        <text key={steer.id} fg={theme.dim}>
          {"  "}
          {glyph.queued} {steer.text}
        </text>
      ))}
    </box>
  );
}

/** The lit line: spinner in column 0, a space, then the label from column 2 on. */
function ShimmeringLine(props: { label: string; now: number }): React.ReactNode {
  const TEXT_OFFSET = 2;
  // The icon and its space are part of the strip the light crosses, so the crest is measured over
  // the whole line — otherwise it would appear a word in, out of nowhere.
  const cells = [...props.label].length + TEXT_OFFSET;
  const crest = shimmerCrest(props.now, cells, WORKING_SHIMMER);

  return (
    <text>
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
