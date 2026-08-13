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
  const available = props.width - chip.length;
  const showBar = spansWidth(stripSpans(meters, meterStyle, true)) <= available;
  const spans = stripSpans(meters, meterStyle, showBar);
  const showHint =
    left.length + 2 + chip.length + spansWidth(spans) <= props.width;

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
        <text>
          <Spans spans={spans} />
        </text>
      </box>
    </box>
  );
}
