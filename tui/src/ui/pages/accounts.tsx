import { useTerminalDimensions } from "@opentui/react";
import { useInput } from "../hooks/use-input.js";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountRow, ClaudeLogin } from "../../app/accounts.service.js";
import { clampIndex } from "../../domain/list-nav.js";
import { fitHints } from "../../domain/hints.js";
import {
  AccountGroup,
  accountsLayout,
} from "../components/account-list.js";
import { AddRow } from "../components/list-parts.js";
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
      <AddRow selected={cursor >= rows.length} label="+ add a Claude account" />
    </Screen>
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
