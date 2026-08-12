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
import { fitColumn } from "../../domain/list-columns.js";
import {
  deletionCost,
  formatWhen,
  jobSummary,
  jobsLayout,
} from "../../domain/jobs-list.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import {
  ListFooter,
  type FooterOverlay,
} from "../components/list-footer.js";
import {
  AddRow,
  Caret,
  ListEmpty,
  NoMatch,
} from "../components/list-parts.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { useComposer, type ComposerControls } from "../hooks/use-composer.js";
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
    // Filtering matches the summary the row actually draws (`build · builder`), which is the only
    // thing about a job's condition there is to type at.
    () => all.filter((job) => matchesQuery(query, job.title, jobSummary(job))),
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
        .createJob({ projectId: props.project.id, title })
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
        <ListFooter
          width={width}
          height={height}
          overlay={overlayFor({ mode, composer })}
          confirm={
            mode === "confirm" && highlighted ? (
              <ConfirmBar
                question={`delete “${highlighted.title}”?`}
                detail={deletionCost(highlighted)}
              />
            ) : null
          }
          hints={mode === "browse" ? HINTS : undefined}
          shortcuts={shortcuts}
          error={error}
        />
      }
    >
      <ListEmpty
        show={all.length === 0 && mode !== "create"}
        headline="No jobs yet."
        hint="A job is one unit of work plus a shared /context folder."
      />
      <NoMatch show={all.length > 0 && rows.length === 0} query={query} />

      {rows.map((job, index) => {
        const working =
          job.activeThreadId !== null && running.includes(job.activeThreadId);
        return (
          <text key={job.id}>
            <Caret on={index === cursor} />
            {/* The spinner replaces the status dot rather than sitting beside it — a working job is
                a state of the job, not a badge on it. */}
            <span fg={theme.accent}>{working ? frame : glyph.active} </span>
            <span>{fitColumn(job.title, layout.title)}</span>
            {layout.status > 0 ? (
              working ? (
                <span fg={theme.accent}>
                  {fitColumn("working…", layout.status)}
                </span>
              ) : (
                <span fg={theme.dim}>
                  {fitColumn(jobSummary(job), layout.status)}
                </span>
              )
            ) : null}
            <span fg={theme.dim}>{formatWhen({ date: job.updatedAt })}</span>
          </text>
        );
      })}

      <text> </text>
      <AddRow selected={cursor >= rows.length} label="+ new job" />
    </Screen>
  );
}

const HINTS = [
  "↑↓ select · →/⏎ open · / filter · n new · x delete · ? keys · ←/esc back",
  "↑↓ select · ⏎ open · / filter · n new · x delete · ? keys · esc back",
  "⏎ open · / filter · n new · ? keys",
];

/** Only these two modes borrow the footer's composer. Engine is not an input — it follows the role. */
const OVERLAYS: Partial<Record<Mode, { placeholder: string; caption: string }>> =
  {
    create: {
      placeholder: "fix steering",
      caption:
        "new job · starts an intake thread on claude          ⏎ create · esc",
    },
    filter: {
      placeholder: "filter…",
      caption: "↑↓ select · ⏎ open · esc clear",
    },
  };

function overlayFor(args: {
  mode: Mode;
  composer: ComposerControls;
}): FooterOverlay | undefined {
  const form = OVERLAYS[args.mode];
  if (!form) return undefined;
  return {
    ...form,
    state: args.composer.state,
    onCaret: args.composer.setCursor,
  };
}
