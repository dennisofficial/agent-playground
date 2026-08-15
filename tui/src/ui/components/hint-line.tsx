import React from "react";
import { CANARY } from "../../domain/canary.js";
import {
  EContextSignal,
  formatTokens,
  type ContextReading,
} from "../../domain/context-nudge.js";
import { meterBand, type Meter, type UsageWindow } from "../../domain/usage.js";
import { meterStyle } from "../meter-style.js";
import { spansWidth, stripSpans } from "../meter-spans.js";
import { theme } from "../theme.js";
import { Spans } from "./spans.js";

export function HintLine(props: {
  hints: string;
  accountLabel?: string | undefined;
  /** Tokens on the digits, window occupancy in the bar, budget pressure in the colour. */
  contextReading: ContextReading | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  width: number;
  /** Replaces the account chip when every account is walled. */
  allLimitedUntil?: string | undefined;
  /**
   * No credential is selected for this conversation, and why. It takes the whole left side because it
   * is the only thing on this line that stops work — the hints describe keys that will not do anything
   * until it is resolved, and the meters have nothing to measure.
   */
  noAccount?: string | null | undefined;
  /**
   * Which model is running, and how many sessions this thread has been through.
   *
   * They sit beside `ctx` rather than in the header because that meter IS this model's window and
   * the ordinal is WHY it last reset — the three are one instrument. On the header's right edge
   * they were two orphans crowding out the status.
   */
  model?: string | undefined;
  sessionOrdinal?: number | undefined;
}): React.ReactNode {
  const left =
    props.noAccount ??
    (props.allLimitedUntil
      ? `all accounts limited · resumes ${props.allLimitedUntil}`
      : props.hints);

  const chip =
    props.accountLabel && !props.allLimitedUntil && !props.noAccount
      ? `${props.accountLabel} `
      : "";

  // Two instruments share one meter, so the meter says WHICH it is drawing: a session that is
  // expensive to keep and one that has stopped following instructions are different situations and
  // want different answers. The canary takes the label only once it is properly dead — see
  // `canaryHealth`.
  const reading = props.contextReading;
  const canaryDriving = reading?.signal === EContextSignal.canary;

  const meters: [Meter, Meter, Meter] = [
    // `ctx` has no reset time — a context window is emptied by rotating, not by waiting.
    {
      label: canaryDriving ? `ctx${CANARY}` : "ctx",
      band: reading?.band ?? "unknown",
      window: reading === null ? null : { utilization: reading.percent, resetsAt: null },
      ...(reading === null ? {} : { digits: formatTokens(reading.tokens) }),
    },
    {
      label: "5h",
      band: meterBand("fiveHour", props.fiveHour?.utilization ?? null),
      window: props.fiveHour,
    },
    {
      label: "wk",
      band: meterBand("sevenDay", props.sevenDay?.utilization ?? null),
      window: props.sevenDay,
    },
  ];

  // Everything the line can shed, in the order it sheds it. The gauges go before any number does —
  // a number is the part you cannot reconstruct by looking. The hint goes first of all, because what
  // you can press is guessable and how close you are to a wall is not.
  // Sheds before any gauge does: which model is running is the one thing on this line you could
  // also find out just by asking the agent. `claude-opus-5` is shortened because the engine is
  // already in the model's name, and printing both says neither.
  const engine = props.model
    ? `${props.model.replace(/^claude-/, "")}${(props.sessionOrdinal ?? 1) > 1 ? ` s${props.sessionOrdinal}` : ""} `
    : "";
  const available = props.width - chip.length - engine.length;
  const showBar = spansWidth(stripSpans(meters, meterStyle, true)) <= available;
  const spans = stripSpans(meters, meterStyle, showBar);
  const showEngine =
    engine.length + chip.length + spansWidth(spans) <= props.width;
  const showHint =
    left.length + 2 + chip.length + (showEngine ? engine.length : 0) + spansWidth(spans) <=
    props.width;

  return (
    <box flexDirection="row" justifyContent="space-between" width={props.width}>
      {/* Never shed: a conversation that cannot run has to say so at every width, where a hint is
          something you can afford to lose. */}
      <text fg={props.noAccount ? theme.warn : theme.dim}>
        {props.noAccount ?? (showHint ? left : "")}
      </text>
      <box flexDirection="row">
        {/* The account chip appears ONLY when more than one account exists — with a single login
            it is noise, and the meters already describe the only account there is. */}
        {chip ? <text fg={theme.dim}>{chip}</text> : null}
        {/* `opus-5 s2`, in front of the meters it explains. */}
        {engine && showEngine ? <text fg={theme.dim}>{engine}</text> : null}
        <text>
          <Spans spans={spans} />
        </text>
      </box>
    </box>
  );
}
