import React from "react";
import type { AccountRow } from "../../app/accounts.service.js";
import {
  accountMeterWidths,
  accountRowLayout,
  badgeText,
  extraUsageFlag,
  GUTTER,
  meterColumnWidth,
  type AccountRowLayout,
} from "../../domain/account-row.js";
import { fitColumn } from "../../domain/list-columns.js";
import { meterBand, type Meter, type MeterKey } from "../../domain/usage.js";
import { meterStyle, type Span } from "../meter-style.js";
import { bandColour, meterSpans, spansWidth } from "../meter-spans.js";
import { Caret } from "./list-parts.js";
import { Spans } from "./spans.js";
import { glyph, theme } from "../theme.js";

/**
 * The list's columns at a given terminal width — ONE layout for every row, not one per row. Columns
 * are only a table if every row agrees on them, so the widest label decides nothing here and the
 * terminal decides everything.
 *
 * Exported alongside `AccountGroup` so `render-smoke.spec.tsx` can mount the real thing at several
 * widths rather than a reconstruction of it.
 */
export function accountsLayout(
  width: number,
  accounts: AccountRow[],
): AccountRowLayout {
  return accountRowLayout(
    width,
    METER_WIDTHS,
    accounts.some((a) => badgeText(a) !== null),
  );
}

/** Exported for `render-smoke.spec.tsx` — this row is where the nested-`<text>` crash landed. */
export function AccountGroup(props: {
  label: string;
  accounts: AccountRow[];
  rows: AccountRow[];
  selected: number;
  layout: AccountRowLayout;
}): React.ReactNode {
  if (props.accounts.length === 0) return null;
  return (
    <box flexDirection="column">
      <text fg={theme.dim}>{props.label}</text>
      {props.accounts.map((account) => (
        <AccountRowView
          key={account.id}
          account={account}
          selected={props.rows.indexOf(account) === props.selected}
          layout={props.layout}
        />
      ))}
    </box>
  );
}

function AccountRowView(props: {
  account: AccountRow;
  selected: boolean;
  layout: AccountRowLayout;
}): React.ReactNode {
  const { account, layout } = props;
  const badge = badgeText(account);

  const identity = (
    <>
      <Caret on={props.selected} />
      <span fg={account.isActive ? theme.accent : theme.dim}>
        {account.isActive ? glyph.active : glyph.available}{" "}
      </span>
      {/* Wrapped, nothing follows the label but the badge, so the padding that makes a column stops
          being alignment and becomes a gap the eye has to cross. */}
      <span>{fit(account.label ?? "", layout.label, layout.lines === 2)}</span>
    </>
  );

  const usage = (
    <>
      {layout.plan > 0 ? (
        <span fg={theme.dim}>
          {fitColumn(account.subscriptionType ?? "—", layout.plan)}
        </span>
      ) : null}
      <Spans spans={usageSpans(account, layout.showBar)} />
      {layout.flags > 0 ? <Spans spans={flagSpans(account, layout.flags)} /> : null}
    </>
  );

  const warning =
    badge && layout.badge !== "none" ? (
      <span fg={theme.warn}>
        {"   "}
        {layout.badge === "text" ? `${glyph.warning} ${badge}` : glyph.warning}
      </span>
    ) : null;

  // One line or two, decided once for the whole list. Wrapped, the usage sits under the label rather
  // than beside it, and the warning stays on the identity line — it is a fact about the ACCOUNT, not
  // about its usage, and it is the reason the eye stopped on this row.
  if (layout.lines === 1) {
    return (
      <text>
        {identity}
        {usage}
        {warning}
      </text>
    );
  }

  return (
    <box flexDirection="column">
      <text>
        {identity}
        {warning}
      </text>
      <text>
        {" ".repeat(GUTTER)}
        {usage}
      </text>
    </box>
  );
}


function fit(value: string, width: number, ragged: boolean): string {
  const fitted = fitColumn(value, width);
  return ragged ? fitted.trimEnd() : fitted;
}

/**
 * `5h ▰▰▱▱▱  34%  wk ▰▰▰▱▱  61%` — the SAME meters the composer footer draws, from the same
 * `meterSpans`. One account's usage must not read as a different quantity depending on which page is
 * showing it, and the whole look lives in one line of `ui/meter-style.ts`.
 *
 * `—` instead of `0%` is honest: usage is polled per account, so one that has not run recently has
 * UNKNOWN usage, not idle usage. Rotation prefers known headroom over unknown.
 */
function usageSpans(account: AccountRow, showBar: boolean): Span[] {
  return [
    ...padMeter(
      meterFor(
        "5h",
        "fiveHour",
        account.fiveHourUtil,
        account.fiveHourResetsAt,
      ),
      showBar,
    ),
    { text: " ".repeat(meterStyle.separation.gap) },
    ...padMeter(
      meterFor(
        "wk",
        "sevenDay",
        account.sevenDayUtil,
        account.sevenDayResetsAt,
      ),
      showBar,
    ),
  ];
}

/**
 * `xu 24%  fast` — the two standing decisions, in the same column on every row.
 *
 * Words rather than symbols. The obvious glyph for fast mode is a lightning bolt, and every emoji in
 * a terminal is double-width — a cell count that is right on one terminal and wrong on the next
 * drags the whole table out of alignment, which is the same reason `glyph.image` is geometric.
 *
 * An account with neither setting on draws nothing but padding: the flags exist to mark the
 * exceptions, and a list where every row says `off` twice is a list that has stopped pointing.
 */
function flagSpans(account: AccountRow, width: number): Span[] {
  const flag = extraUsageFlag(account);
  const extra: Span | null =
    flag.state === "off"
      ? null
      : flag.state === "on"
        ? {
            text: flag.percent === null ? "xu" : `xu ${flag.percent}%`,
            fg: bandColour(meterBand("extraUsage", flag.percent), meterStyle),
          }
        : {
            // Permitted but unusable, which is a state worth a colour: the human has said yes and
            // the account cannot honour it.
            text: flag.state === "spent" ? "xu —" : "xu n/a",
            fg: theme.warn,
          };

  const spans: Span[] = [
    { text: " " },
    ...(extra ? [extra] : []),
    ...(account.fastMode
      ? [{ text: `${extra ? " " : ""}fast`, fg: theme.accent }]
      : []),
  ];
  const short = Math.max(0, width - spansWidth(spans));
  return short > 0 ? [...spans, { text: " ".repeat(short) }] : spans;
}

function meterFor(
  label: string,
  key: MeterKey,
  util: number | null,
  resetsAt: Date | null,
): Meter {
  return {
    label,
    // An account window is coloured by its own fill — it is the one thing there is to know about it.
    band: meterBand(key, util),
    window:
      util === null
        ? null
        : { utilization: util, resetsAt: resetsAt?.toISOString() ?? null },
  };
}

/** The gauge/gap costs are `ui`'s to know; the column budget they imply is `domain`'s to compute. */
const METER_WIDTHS = accountMeterWidths({
  gaugeCells: meterStyle.glyphs.cells,
  gap: meterStyle.separation.gap,
});

function meterWidth(showBar: boolean): number {
  return meterColumnWidth({
    gaugeCells: showBar ? meterStyle.glyphs.cells : 0,
  });
}

/**
 * A list is a table: the status badge after the meters has to start in the same column on every row,
 * and a spent window (`wk 2h14m`) is narrower than a measured one. The footer never needs this
 * because it draws one account, right-aligned, on its own line.
 */
function padMeter(meter: Meter, showBar: boolean): Span[] {
  const spans = meterSpans(meter, meterStyle, showBar);
  const short = Math.max(0, meterWidth(showBar) - spansWidth(spans));
  return short > 0 ? [...spans, { text: " ".repeat(short) }] : spans;
}
