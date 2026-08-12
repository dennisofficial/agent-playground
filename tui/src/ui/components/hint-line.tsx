import React from "react";
import type { Meter, UsageWindow } from "../../domain/usage.js";
import { meterStyle } from "../meter-style.js";
import { spansWidth, stripSpans } from "../meter-spans.js";
import { theme } from "../theme.js";
import { Spans } from "./spans.js";

export function HintLine(props: {
  hints: string;
  accountLabel?: string | undefined;
  contextPercent: number | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  width: number;
  /** Replaces the account chip when every account is walled. */
  allLimitedUntil?: string | undefined;
}): React.ReactNode {
  const left = props.allLimitedUntil
    ? `all accounts limited · resumes ${props.allLimitedUntil}`
    : props.hints;

  const chip =
    props.accountLabel && !props.allLimitedUntil
      ? `${props.accountLabel} `
      : "";

  const meters: [Meter, Meter, Meter] = [
    // `ctx` has no reset time — a context window is emptied by rotating, not by waiting.
    {
      label: "ctx",
      key: "ctx",
      window:
        props.contextPercent === null
          ? null
          : { utilization: props.contextPercent, resetsAt: null },
    },
    { label: "5h", key: "fiveHour", window: props.fiveHour },
    { label: "wk", key: "sevenDay", window: props.sevenDay },
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
      <text fg={theme.dim}>{showHint ? left : ""}</text>
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
