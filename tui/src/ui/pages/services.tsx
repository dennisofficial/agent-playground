import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useState } from "react";
import { fitColumn, fitColumnEnd } from "../../domain/list-columns.js";
import { clampIndex } from "../../domain/list-nav.js";
import { fitHints } from "../../domain/hints.js";
import { collapseHome } from "../../domain/paths.js";
import {
  describeStatus,
  formatUptime,
  isRunning,
  servicesLayout,
  type ServiceEntry,
  type ServicesLayout,
} from "../../domain/services.js";
import { Caret, ListEmpty } from "../components/list-parts.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { useInput } from "../hooks/use-input.js";
import { useTick } from "../hooks/use-conversation.js";
import { useServices } from "../services.js";
import { theme } from "../theme.js";

/**
 * The job's long-lived processes, and the only place a human can see or end one.
 *
 * Scoped to the CURRENT job rather than showing every service Atlas holds: services are job-owned,
 * and a cross-job list would immediately raise "whose is this and what happens if I kill it" — a
 * question the ownership model already answers by never asking it.
 *
 * Read straight off the registry on every render rather than mirrored into state. The registry is
 * the truth, `useTick` re-renders this page once a second for the uptime column anyway, and a copy
 * would only be a second thing that can be stale.
 */
export function ServicesPage(props: {
  jobId: string;
  jobTitle: string;
  onBack: () => void;
}): React.ReactNode {
  const { serviceRegistryService } = useServices();
  const { width } = useTerminalDimensions();
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // One second, matching the coarsest thing `formatUptime` prints. It is also what makes a service
  // that dies on its own turn from `running` to `exited (1)` here without anyone pressing a key.
  const { now } = useTick(true, 1000);

  const entries = serviceRegistryService.listFor(props.jobId);
  const cursor = clampIndex(selected, entries.length);
  const highlighted = entries[cursor];

  const kill = useCallback(
    (entry: ServiceEntry) => {
      setNotice(`stopping ${entry.id}…`);
      void serviceRegistryService
        .stop({ jobId: props.jobId, id: entry.id })
        .then(setNotice)
        // `stop` answers in prose and does not throw for a group that is already gone, so anything
        // arriving here is the unexpected case and is worth showing rather than swallowing.
        .catch((error: Error) => setNotice(error.message));
    },
    [props.jobId, serviceRegistryService],
  );

  useInput((input, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) return setSelected(clampIndex(cursor - 1, entries.length));
    if (key.downArrow)
      return setSelected(clampIndex(cursor + 1, entries.length));
    // Only a live one. Pressing `k` on a row that already exited would answer "already gone", which
    // is a correct sentence and a pointless one.
    if (input === "k" && highlighted && isRunning(highlighted)) {
      kill(highlighted);
    }
  });

  const layout = servicesLayout(width);

  return (
    <Screen
      header={
        <PageHeader
          trail={["atlas", props.jobTitle, "services"]}
          right={countLabel(entries)}
          canBack
        />
      }
      footer={
        <box flexDirection="column">
          <text fg={theme.dim}>{fitHints(width, HINTS)}</text>
          {notice ? (
            <text fg={theme.dim}>
              {"  "}
              {fitColumn(notice, width - 2)}
            </text>
          ) : null}
        </box>
      }
    >
      <ListEmpty
        show={entries.length === 0}
        headline="No services in this job."
        hint="The agent starts one with `service_start` — a dev server, a watcher, anything that should still be running after its turn ends."
      />

      {entries.map((entry, index) => (
        <ServiceRow
          key={entry.id}
          entry={entry}
          selected={index === cursor}
          layout={layout}
          now={now}
        />
      ))}
    </Screen>
  );
}

/**
 * Three lines per service, because the two the human copies — the command and the log path — are
 * both too long to be columns. They are dim so the scannable line stays the first one.
 *
 * Each line is its own `<text>` inside a `<box>`: `<text>` does not nest, and the caret and spans
 * on line one are the exact shape that has crashed the renderer before.
 */
function ServiceRow(props: {
  entry: ServiceEntry;
  selected: boolean;
  layout: ServicesLayout;
  now: number;
}): React.ReactNode {
  const { entry, layout } = props;
  const live = isRunning(entry);

  return (
    <box flexDirection="column">
      <text>
        <Caret on={props.selected} />
        <span fg={live ? undefined : theme.dim}>
          {fitColumn(entry.description, layout.description)}
        </span>
        <span fg={live ? theme.accent : theme.dim}>
          {fitColumn(describeStatus(entry), layout.status)}
        </span>
        <span fg={theme.dim}>
          {fitColumn(uptimeLabel({ entry, now: props.now }), layout.uptime)}
        </span>
      </text>
      <text fg={theme.dim}>
        {"      "}
        {fitColumn(entry.command, layout.detail)}
      </text>
      {/* Clipped from the FRONT: a log path's meaning is its tail, and `…/logs/1f2e.log` still tells
          you which file to open where `/Users/dennis/Deve…` tells you nothing. */}
      <text fg={theme.dim}>
        {"      log: "}
        {fitColumnEnd(collapseHome(entry.logPath), layout.detail - 5)}
      </text>
    </box>
  );
}

/**
 * `up 12m` while it is alive, `started 12m ago` once it is not.
 *
 * Nothing records when a dead service died, so its age is time since it STARTED. Left unlabelled
 * that reads as "it ran for three hours" when it may have fallen over in the first second — the
 * same trap `describeService` calls out for the agent's own view.
 */
function uptimeLabel(args: { entry: ServiceEntry; now: number }): string {
  const age = formatUptime(args.now - args.entry.startedAt);
  return isRunning(args.entry) ? `up ${age}` : `${age} old`;
}

function countLabel(entries: readonly ServiceEntry[]): string {
  const live = entries.filter(isRunning).length;
  return `${live} running · ${entries.length} total`;
}

/**
 * Three lengths. `k stop` survives all of them: it is the only thing this page DOES, and a page that
 * only lists is one the human has to leave to act on.
 */
const HINTS = [
  "↑↓ select · k stop · ←/esc back",
  "↑↓ select · k stop · esc back",
  "k stop · esc",
];
