import { useTerminalDimensions } from "@opentui/react";
import { useInput } from "../hooks/use-input.js";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectRow } from "../../app/workspace.service.js";
import type { JobRow } from "../../store/job.repository.js";
import { clampIndex, matchesQuery } from "../../domain/list-nav.js";
import {
  affords,
  elasticColumn,
  fitColumn,
} from "../../domain/list-columns.js";
import { fitHints } from "../../domain/hints.js";
import { roleLabel } from "../../domain/role-engine.js";
import { EJobStatus } from "../../generated/prisma/enums.js";
import { Composer } from "../components/composer.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { ListShortcuts } from "../components/shortcuts.js";
import { useComposer } from "../hooks/use-composer.js";
import { useRunningThreads, useTick } from "../hooks/use-conversation.js";
import { useServices } from "../services.js";
import { glyph, theme } from "../theme.js";

/** What the page is waiting for. Exactly one of these owns the keyboard at a time. */
type Mode = "browse" | "filter" | "create" | "confirm";

export function JobsPage(props: {
  project: ProjectRow;
  /** The job last opened — the cursor lands on it when you come back, not on row zero. */
  focusId?: string | undefined;
  onOpen: (job: JobRow) => void;
  onBack: () => void;
}): React.ReactNode {
  const { workspaceService } = useServices();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("browse");
  const [shortcuts, setShortcuts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { width, height } = useTerminalDimensions();
  // A filter and a job title, never a draft: one line.
  const composer = useComposer("", { singleLine: true });

  // Which of these jobs has an agent working in it right now. Without this a job you walked away
  // from is indistinguishable from an idle one, and the whole point of leaving it running is lost.
  const running = useRunningThreads();
  const { frame } = useTick(running.length > 0);

  const reload = useCallback(async () => {
    setJobs(await workspaceService.listJobs(props.project.id));
  }, [workspaceService, props.project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A turn starting or finishing changes `updatedAt` and the message count under us. Cheap: one
  // SQLite read, and only when the set of working threads actually changes.
  useEffect(() => {
    void reload();
  }, [running.length, reload]);

  // The composer IS the query while filtering — see the same note on the projects page.
  const query = mode === "filter" ? composer.value : "";

  const all = useMemo(() => jobs ?? [], [jobs]);
  const rows = useMemo(
    () => all.filter((job) => matchesQuery(query, job.title, job.status)),
    [all, query],
  );
  const total = rows.length + 1; // + "new job"
  const layout = jobsLayout(width);

  const cursor = clampIndex(selected, total);
  const highlighted = cursor < rows.length ? rows[cursor] : undefined;

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || jobs === null) return;
    restored.current = true;
    const index = props.focusId
      ? jobs.findIndex((job) => job.id === props.focusId)
      : -1;
    if (index >= 0) setSelected(index);
  }, [jobs, props.focusId]);

  const leaveMode = useCallback(() => {
    setMode("browse");
    composer.clear();
  }, [composer]);

  const create = useCallback(
    (title: string) => {
      if (title.length === 0) return;
      leaveMode();
      void workspaceService
        .createJob(props.project.id, title)
        .then(() => reload())
        .catch((e: Error) => setError(e.message));
    },
    [leaveMode, props.project.id, reload, workspaceService],
  );

  const remove = useCallback(
    (job: JobRow) => {
      leaveMode();
      setError(null);
      void workspaceService
        .deleteJob(job.id)
        .then(() => reload())
        .catch((e: Error) => setError(e.message));
    },
    [leaveMode, reload, workspaceService],
  );

  useInput((input, key) => {
    if (mode === "create") {
      if (key.escape) return leaveMode();
      if (key.return) return create(composer.value.trim());
      composer.handleKey(input, key);
      return;
    }

    if (mode === "confirm") {
      if (input === "y" && highlighted) return remove(highlighted);
      return leaveMode();
    }

    if (mode === "filter") {
      if (key.upArrow) return setSelected(clampIndex(cursor - 1, total));
      if (key.downArrow) return setSelected(clampIndex(cursor + 1, total));
      if (key.escape) return leaveMode();
      if (key.return) {
        if (highlighted) {
          leaveMode();
          props.onOpen(highlighted);
        } else {
          composer.clear();
          setMode("create");
        }
        return;
      }
      composer.handleKey(input, key);
      return;
    }

    // `←` and `esc` are the same door. On a list there is nothing for `←` to mean other than "out",
    // and reaching for it is the reflex a two-pane file browser trains.
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) return setSelected(clampIndex(cursor - 1, total));
    if (key.downArrow) return setSelected(clampIndex(cursor + 1, total));
    // `→` descends, the exact mirror of `←`.
    if (key.return || key.rightArrow) {
      if (highlighted) return props.onOpen(highlighted);
      return setMode("create");
    }
    if (input === "/") return setMode("filter");
    if (input === "n") return setMode("create");
    if (input === "x" && highlighted) return setMode("confirm");
    if (input === "?") return setShortcuts((open) => !open);
  });

  const trail = ["atlas", props.project.name];

  if (jobs === null) {
    return (
      <Screen header={<PageHeader trail={trail} canBack />}>
        <text fg={theme.dim}>loading…</text>
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <PageHeader
          trail={trail}
          canBack
          {...(query.length > 0
            ? { right: `${rows.length}/${all.length}` }
            : {})}
        />
      }
      footer={
        <box flexDirection="column">
          {mode === "create" ? (
            <box flexDirection="column">
              <Composer
                state={composer.state}
                width={composerWidth(width)}
                placeholder="fix steering"
                onCaret={composer.setCursor}
              />
              {/* Engine is not an input — it follows the role. */}
              <text fg={theme.dim}>
                {"  "}new job · starts an intake thread on claude{"          "}⏎
                create · esc
              </text>
            </box>
          ) : null}

          {mode === "filter" ? (
            <box flexDirection="column">
              <Composer
                state={composer.state}
                width={composerWidth(width)}
                placeholder="filter…"
                onCaret={composer.setCursor}
              />
              <text fg={theme.dim}>{"  "}↑↓ select · ⏎ open · esc clear</text>
            </box>
          ) : null}

          {mode === "confirm" && highlighted ? (
            <ConfirmBar
              question={`delete “${highlighted.title}”?`}
              detail={deletionCost(highlighted)}
            />
          ) : null}

          {mode === "browse" ? (
            shortcuts ? (
              <ListShortcuts width={width} height={height} />
            ) : (
              <text fg={theme.dim}>{fitHints(width, HINTS)}</text>
            )
          ) : null}

          {error ? (
            <text fg={theme.error}>
              {"  "}
              {error}
            </text>
          ) : null}
        </box>
      }
    >
      {all.length === 0 && mode !== "create" ? (
        <box flexDirection="column">
          <text>No jobs yet.</text>
          <text fg={theme.dim}>
            A job is one unit of work plus a shared /context folder.
          </text>
          <text> </text>
        </box>
      ) : null}

      {all.length > 0 && rows.length === 0 ? (
        <box flexDirection="column">
          <text fg={theme.dim}>
            {"    "}Nothing matches “{query}”.
          </text>
          <text> </text>
        </box>
      ) : null}

      {rows.map((job, index) => {
        const working =
          job.activeThreadId !== null && running.includes(job.activeThreadId);
        return (
          <text key={job.id}>
            {index === cursor ? (
              <span fg={theme.accent}>{`  ${glyph.selected} `}</span>
            ) : (
              "    "
            )}
            {/* The spinner replaces the status dot rather than sitting beside it — a working job is
                a state of the job, not a badge on it. */}
            <span
              fg={
                job.status === EJobStatus.shipped && !working
                  ? theme.dim
                  : theme.accent
              }
            >
              {working ? frame : glyph.active}{" "}
            </span>
            <span>{fitColumn(job.title, layout.title)}</span>
            {layout.status > 0 ? (
              working ? (
                <span fg={theme.accent}>
                  {fitColumn("working…", layout.status)}
                </span>
              ) : (
                <span fg={theme.dim}>
                  {fitColumn(describe(job), layout.status)}
                </span>
              )
            ) : null}
            <span fg={theme.dim}>{formatWhen(job.updatedAt)}</span>
          </text>
        );
      })}

      <text> </text>
      <text>
        {cursor >= rows.length ? (
          <span fg={theme.accent}>{`  ${glyph.selected} `}</span>
        ) : (
          "    "
        )}
        <span fg={theme.dim}>+ new job</span>
      </text>
    </Screen>
  );
}

const HINTS = [
  "↑↓ select · →/⏎ open · / filter · n new · x delete · ? keys · ←/esc back",
  "↑↓ select · ⏎ open · / filter · n new · x delete · ? keys · esc back",
  "⏎ open · / filter · n new · ? keys",
];

/** A bordered box does not wrap: wider than the terminal and it draws off the edge. */
function composerWidth(width: number): number {
  return Math.min(72, width - 2);
}

/** `  ▸ ` + `⏺ `, and the timestamp at the end — the two columns that are never negotiable. */
const GUTTER = 6;
const WHEN = 5;
const MARGIN = 2;
/** `build · builder` wants twenty columns; `shipped` and `working…` fit in ten. */
const STATUS_FORMS = [20, 10, 0];
const TITLE = { min: 16, max: 56 };

function jobsLayout(width: number): { title: number; status: number } {
  for (const status of STATUS_FORMS) {
    const fixed = GUTTER + status + WHEN + MARGIN;
    if (affords(width, fixed, TITLE.min))
      return { title: elasticColumn(width, fixed, TITLE), status };
  }
  return { title: Math.max(3, width - GUTTER - WHEN - MARGIN), status: 0 };
}

/** There is no archive state and no undo, so the confirm quotes the transcript it is about to burn. */
function deletionCost(job: JobRow): string {
  const messages =
    job.messageCount === 0
      ? "nothing said yet"
      : `${job.messageCount} message${job.messageCount === 1 ? "" : "s"}`;
  return `${messages} · every thread, session and the job’s /context folder go with it`;
}

function describe(job: JobRow): string {
  if (job.status === EJobStatus.shipped) return "shipped";
  if (!job.activeGroup || !job.activeRole) return "active";
  return `${job.activeGroup} · ${roleLabel(job.activeRole)}`;
}

/** Today shows a clock, this week a weekday, older a date — the same shape the wireframes use. */
function formatWhen(date: Date): string {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
