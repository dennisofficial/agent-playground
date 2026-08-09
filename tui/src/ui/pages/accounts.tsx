import { useTerminalDimensions } from "@opentui/react";
import { useInput } from "../hooks/use-input.js";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountRow, ClaudeLogin } from "../../app/accounts.service.js";
import { clampIndex } from "../../domain/list-nav.js";
import {
  accountRowLayout,
  GUTTER,
  type AccountRowLayout,
  type MeterWidths,
} from "../../domain/account-row.js";
import { fitColumn } from "../../domain/list-columns.js";
import { fitHints } from "../../domain/hints.js";
import type { Meter, MeterKey } from "../../domain/usage.js";
import {
  meterSpans,
  meterStyle,
  spansWidth,
  type Span,
} from "../meter-style.js";
import { EAccountStatus, EEngine } from "../../generated/prisma/enums.js";
import { Composer } from "../components/composer.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { ListShortcuts } from "../components/shortcuts.js";
import { Spans } from "../components/spans.js";
import { useComposer } from "../hooks/use-composer.js";
import { useServices } from "../services.js";
import { glyph, theme } from "../theme.js";

type Mode = "browse" | "login" | "confirm";

export function AccountsPage(props: { onBack: () => void }): React.ReactNode {
  const { accountsService } = useServices();
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("browse");
  const [shortcuts, setShortcuts] = useState(false);
  const { width, height } = useTerminalDimensions();
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The OAuth `code#state`, pasted out of a browser — one line, and it arrives with the newline the
  // copy picked up.
  const composer = useComposer("", { singleLine: true });

  const reload = useCallback(async () => {
    setAccounts(await accountsService.list());
  }, [accountsService]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The rows are drawn grouped by engine, so the SELECTION has to walk them in that same order.
  // Indexing into the unordered list meant `↓` could jump from the top of the claude group into the
  // middle of the codex one.
  const rows = useMemo(() => {
    const all = accounts ?? [];
    return [
      ...all.filter((a) => a.engine === EEngine.claude),
      ...all.filter((a) => a.engine !== EEngine.claude),
    ];
  }, [accounts]);

  const total = rows.length + 1; // + "add a Claude account"
  const cursor = clampIndex(selected, total);
  const highlighted = cursor < rows.length ? rows[cursor] : undefined;

  const remove = useCallback(
    (account: AccountRow) => {
      setMode("browse");
      setError(null);
      void accountsService
        .remove(account.id)
        .then(() => reload())
        .catch((e: Error) => setError(e.message));
    },
    [accountsService, reload],
  );

  useInput((input, key) => {
    if (mode === "login" && login) {
      if (key.escape) {
        setMode("browse");
        setLogin(null);
        composer.clear();
        setError(null);
        return;
      }
      if (key.return && !busy) {
        const code = composer.value.trim();
        if (code.length === 0) return;
        setBusy(true);
        composer.clear();
        void accountsService
          .completeClaudeLogin(login, code)
          .then(async () => {
            setMode("browse");
            setLogin(null);
            setError(null);
            await reload();
          })
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
        return;
      }
      composer.handleKey(input, key);
      return;
    }

    if (mode === "confirm") {
      if (input === "y" && highlighted) return remove(highlighted);
      return setMode("browse");
    }

    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) return setSelected(clampIndex(cursor - 1, total));
    if (key.downArrow) return setSelected(clampIndex(cursor + 1, total));
    if (key.return && !highlighted) {
      setLogin(accountsService.beginClaudeLogin());
      setMode("login");
      return;
    }
    if (input === "n") {
      setLogin(accountsService.beginClaudeLogin());
      setMode("login");
      return;
    }
    if (input === "x" && highlighted) return setMode("confirm");
    if (input === "?") return setShortcuts((open) => !open);
  });

  if (accounts === null) {
    return (
      <Screen header={<PageHeader trail={["atlas", "accounts"]} canBack />}>
        <text fg={theme.dim}>loading…</text>
      </Screen>
    );
  }

  if (mode === "login" && login) {
    return (
      <Screen
        header={
          <PageHeader
            trail={["atlas", "accounts", "add"]}
            right="claude"
            canBack
          />
        }
        footer={
          <box flexDirection="column">
            {/* A bordered box does not wrap: wider than the terminal and it draws off the edge. */}
            <Composer
              state={composer.state}
              width={Math.min(72, width - 2)}
              placeholder="code#state"
              onCaret={composer.setCursor}
            />
            <text fg={theme.dim}>
              {busy ? "  exchanging…" : "  ⏎ submit · esc cancel"}
            </text>
            {error ? (
              <text fg={theme.error}>
                {"  "}
                {error}
              </text>
            ) : null}
          </box>
        }
      >
        <text>1. Open this URL and approve:</text>
        <text> </text>
        <text fg={theme.accent}>
          {"   "}
          {login.url}
        </text>
        <text> </text>
        <text>2. Paste the code you’re given:</text>
      </Screen>
    );
  }

  const claude = rows.filter((a) => a.engine === EEngine.claude);
  const codex = rows.filter((a) => a.engine === EEngine.codex);
  const layout = accountsLayout(width, rows);

  return (
    <Screen
      header={<PageHeader trail={["atlas", "accounts"]} canBack />}
      footer={
        <box flexDirection="column">
          {mode === "confirm" && highlighted ? (
            <ConfirmBar
              question={`remove “${highlighted.label}”?`}
              detail="atlas forgets the credential · the subscription itself is untouched"
              confirmLabel="remove"
            />
          ) : shortcuts ? (
            <ListShortcuts width={width} height={height} />
          ) : (
            <text fg={theme.dim}>{fitHints(width, HINTS)}</text>
          )}
          {error ? (
            <text fg={theme.error}>
              {"  "}
              {error}
            </text>
          ) : null}
        </box>
      }
    >
      {rows.length === 0 ? (
        <box flexDirection="column">
          <text>No accounts yet.</text>
          <text> </text>
          <text fg={theme.dim}>
            Atlas signs in on your behalf and rotates between accounts
          </text>
          <text fg={theme.dim}>
            when one hits its usage limit. Add at least one to start.
          </text>
          <text> </text>
        </box>
      ) : null}

      <AccountGroup
        label="claude"
        accounts={claude}
        rows={rows}
        selected={cursor}
        layout={layout}
      />
      <AccountGroup
        label="codex"
        accounts={codex}
        rows={rows}
        selected={cursor}
        layout={layout}
      />

      <text> </text>
      <text>
        {cursor >= rows.length ? (
          <span fg={theme.accent}>{`  ${glyph.selected} `}</span>
        ) : (
          "    "
        )}
        <span fg={theme.dim}>+ add a Claude account</span>
      </text>
    </Screen>
  );
}

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
      {props.selected ? (
        <span fg={theme.accent}>{`  ${glyph.selected} `}</span>
      ) : (
        "    "
      )}
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

/**
 * Three lengths of footer. `? keys` survives all of them: it is the hint that makes the others
 * recoverable, so it is the last one worth dropping.
 */
const HINTS = [
  "↑↓ select · ⏎ add · n add · x remove · ? keys · ←/esc back",
  "↑↓ select · ⏎ add · x remove · ? keys · esc back",
  "⏎ add · x remove · ? keys",
];

function fit(value: string, width: number, ragged: boolean): string {
  const fitted = fitColumn(value, width);
  return ragged ? fitted.trimEnd() : fitted;
}

/** The word a status badge carries, or `null` for the statuses that need no announcement. */
function badgeText(account: AccountRow): string | null {
  if (account.status === EAccountStatus.expired) return "expired";
  if (account.status === EAccountStatus.limited) return "limited";
  return null;
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

function meterFor(
  label: string,
  key: MeterKey,
  util: number | null,
  resetsAt: Date | null,
): Meter {
  return {
    label,
    key,
    window:
      util === null
        ? null
        : { utilization: util, resetsAt: resetsAt?.toISOString() ?? null },
  };
}

/** `label ` + gauge + ` ` + right-aligned percent — the widest ONE meter gets, in each form. */
function meterWidth(showBar: boolean): number {
  return 3 + 4 + (showBar ? meterStyle.glyphs.cells + 1 : 0);
}

/** What the layout has to budget for the pair, so the two agree by construction. */
const METER_WIDTHS: MeterWidths = {
  withGauge: meterWidth(true) * 2 + meterStyle.separation.gap,
  withoutGauge: meterWidth(false) * 2 + meterStyle.separation.gap,
};

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
