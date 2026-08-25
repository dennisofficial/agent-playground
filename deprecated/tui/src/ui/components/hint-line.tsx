import React from "react";
import { CANARY } from "../../domain/canary.js";
import {
  EContextSignal,
  formatTokens,
  type ContextReading,
} from "../../domain/context-nudge.js";
import { meterBand, type Meter, type UsageWindow } from "../../domain/usage.js";
import { footerStyle } from "../meter-style.js";
import { spansWidth, stripSpans } from "../meter-spans.js";
import { theme } from "../theme.js";
import { Spans } from "./spans.js";

/**
 * What the right side gives up as the tile narrows, and in what order.
 *
 * Longest-first, widest-that-fits wins — the rule the header and the trail already use, and the
 * reason there is not a column threshold anywhere in this file.
 *
 * The order is an argument about what you cannot reconstruct by looking. The MODEL goes first
 * because you can simply ask the agent what it is. `wk` goes next because a two-thirds-spent week
 * is Thursday, where the five-hour window is the one that actually walls mid-task. The session
 * ordinal goes last of the three because it is why `ctx` last reset, and a ctx reading with no
 * explanation for its size is a reading you second-guess.
 *
 * `ctx`, `5h` and the PR number never appear here, because they never shed: the first two are the
 * whole point of the line, and the PR is the only place this page names it at all.
 */
type FooterForm = { model: boolean; ordinal: boolean; week: boolean };

/** Everything gone but `ctx`, `5h` and the PR. The floor, and the fallback when nothing fits. */
const NARROWEST: FooterForm = { model: false, ordinal: false, week: false };

const FOOTER_FORMS: readonly FooterForm[] = [
  { model: true, ordinal: true, week: true },
  { model: false, ordinal: true, week: true },
  { model: false, ordinal: true, week: false },
  NARROWEST,
];

export function HintLine(props: {
  hints: string;
  accountLabel?: string | undefined;
  /**
   * Tokens on the digits, budget pressure in the colour.
   *
   * Window occupancy used to be here too, as the bar's fill. It went with the bar and is the one
   * thing that removal actually cost: `210K` alone does not say whether that is a fifth of an Opus
   * window or most of a small one. It is the softest of the three — `budgetFor` drives every nudge
   * off tokens, never off occupancy — which is why it is the one that went.
   */
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
  /** `Job.prNumber` — the pull request this job's branch became, once something has opened one. */
  prNumber?: number | null | undefined;
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

  // `#142`. Never shed: the branch is in the header, but the number the branch became is named
  // nowhere else on this page, and it is the one fact here you would have to leave Atlas to look up.
  const pr = props.prNumber ? `#${props.prNumber} ` : "";

  // `opus-5 s2` — the engine is already in the model's name, so printing both says neither.
  const engineFor = (form: FooterForm): string => {
    if (!props.model) return "";
    const name = form.model ? props.model.replace(/^claude-/, "") : "";
    const ordinal =
      form.ordinal && (props.sessionOrdinal ?? 1) > 1 ? `s${props.sessionOrdinal}` : "";
    const joined = [name, ordinal].filter((part) => part.length > 0).join(" ");
    return joined.length > 0 ? `${joined} ` : "";
  };

  const metersFor = (form: FooterForm): Meter[] =>
    form.week ? [...meters] : [meters[0], meters[1]];

  const rightWidth = (form: FooterForm): number =>
    chip.length +
    pr.length +
    engineFor(form).length +
    spansWidth(stripSpans(metersFor(form), footerStyle));

  // Two columns between the hint and the right side, so the two never touch at the exact width one
  // of them stops fitting.
  const fits = (form: FooterForm): boolean =>
    left.length + 2 + rightWidth(form) <= props.width;

  // The hint is the LAST thing to go, which inverts what this line used to do. Three gauges cost 48
  // columns and were measured before the hint was, so at 80 the meters always won and `esc interrupt
  // · ← leave it running` — 34 columns, and the only thing here that names a key — simply never drew.
  const form = FOOTER_FORMS.find(fits) ?? NARROWEST;
  const showHint = fits(form);
  const engine = engineFor(form);
  const spans = stripSpans(metersFor(form), footerStyle);

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
        {pr ? <text fg={theme.dim}>{pr}</text> : null}
        {/* `opus-5 s2`, in front of the meters it explains. */}
        {engine ? <text fg={theme.dim}>{engine}</text> : null}
        <text>
          <Spans spans={spans} />
        </text>
      </box>
    </box>
  );
}
