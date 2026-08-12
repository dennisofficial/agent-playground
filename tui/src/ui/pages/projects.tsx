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
import { clampIndex, matchesQuery } from "../../domain/list-nav.js";
import { fitColumn, fitColumnEnd } from "../../domain/list-columns.js";
import {
  jobLabel,
  projectsLayout,
  removalCost,
  shortenHome,
} from "../../domain/projects-list.js";
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
import {
  useRunningThreads,
  useTick,
  useWorkingProjects,
} from "../hooks/use-conversation.js";
import { useServices } from "../services.js";
import { glyph, theme } from "../theme.js";

/** What the page is waiting for. Exactly one of these owns the keyboard at a time. */
type Mode = "browse" | "filter" | "open" | "confirm";

export function ProjectsPage(props: {
  /** The project last opened — the cursor lands on it when you come back, not on row zero. */
  focusId?: string | undefined;
  onOpen: (project: ProjectRow) => void;
}): React.ReactNode {
  const { workspaceService } = useServices();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("browse");
  const [shortcuts, setShortcuts] = useState(false);
  const { width, height } = useTerminalDimensions();
  const [error, setError] = useState<string | null>(null);
  // A filter and a folder path, never a draft: one line.
  const composer = useComposer("", { singleLine: true });

  const running = useRunningThreads();
  const working = useWorkingProjects(running);
  const { frame } = useTick(running.length > 0);

  const reload = useCallback(async () => {
    setProjects(await workspaceService.listProjects());
  }, [workspaceService]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A turn finishing changes job counts under us.
  useEffect(() => {
    void reload();
  }, [running.length, reload]);

  // The composer IS the query while filtering — deriving it rather than mirroring it into state is
  // what keeps the two from disagreeing by one keystroke, since `handleKey` cannot report the text
  // it just produced until the next render.
  const query = mode === "filter" ? composer.value : "";

  const all = useMemo(() => projects ?? [], [projects]);
  const rows = useMemo(
    () =>
      all.filter((project) => matchesQuery(query, project.name, project.path)),
    [all, query],
  );
  const total = rows.length + 1; // + "open a folder…"
  const layout = projectsLayout(width);

  // Clamped at RENDER rather than stored, so a filter that shrinks the list or a delete that removes
  // the row under the cursor can never leave the selection pointing past the end — which draws as no
  // selection at all: a page that looks broken instead of one that looks empty.
  const cursor = clampIndex(selected, total);
  const highlighted = cursor < rows.length ? rows[cursor] : undefined;

  // Once, on first load. Re-running it after a reload would fight the user's own cursor.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || projects === null) return;
    restored.current = true;
    const index = props.focusId
      ? projects.findIndex((p) => p.id === props.focusId)
      : -1;
    if (index >= 0) setSelected(index);
  }, [projects, props.focusId]);

  const leaveMode = useCallback(() => {
    setMode("browse");
    composer.clear();
  }, [composer]);

  const openFolder = useCallback(
    (path: string) => {
      leaveMode();
      if (path.length === 0) return;
      void workspaceService
        .openFolder(path)
        .then(() => reload())
        .catch((e: Error) => setError(e.message));
    },
    [leaveMode, reload, workspaceService],
  );

  const remove = useCallback(
    (project: ProjectRow) => {
      leaveMode();
      setError(null);
      void workspaceService
        .deleteProject(project.id)
        .then(() => reload())
        .catch((e: Error) => setError(e.message));
    },
    [leaveMode, reload, workspaceService],
  );

  useInput((input, key) => {
    if (mode === "open") {
      if (key.escape) return leaveMode();
      if (key.return) return openFolder(composer.value.trim());
      composer.handleKey(input, key);
      return;
    }

    if (mode === "confirm") {
      if (input === "y" && highlighted) return remove(highlighted);
      return leaveMode();
    }

    if (mode === "filter") {
      // Arrows still drive the list while filtering, so "type a few letters, ⏎" opens the match
      // without a mode change in between.
      if (key.upArrow) return setSelected(clampIndex(cursor - 1, total));
      if (key.downArrow) return setSelected(clampIndex(cursor + 1, total));
      if (key.escape) return leaveMode();
      if (key.return) {
        if (highlighted) {
          leaveMode();
          props.onOpen(highlighted);
        } else {
          composer.clear();
          setMode("open");
        }
        return;
      }
      composer.handleKey(input, key);
      return;
    }

    if (key.upArrow) return setSelected(clampIndex(cursor - 1, total));
    if (key.downArrow) return setSelected(clampIndex(cursor + 1, total));
    // `→` descends, the exact mirror of `←`. Once the two are a pair the list navigates like a
    // column browser and neither key has to be remembered separately.
    if (key.return || key.rightArrow) {
      if (highlighted) return props.onOpen(highlighted);
      return setMode("open");
    }
    if (input === "/") return setMode("filter");
    if (input === "n") return setMode("open");
    if (input === "x" && highlighted) return setMode("confirm");
    if (input === "?") return setShortcuts((open) => !open);
  });

  if (projects === null) {
    return (
      <Screen header={<PageHeader trail={["atlas"]} />}>
        <text fg={theme.dim}>loading…</text>
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <PageHeader
          trail={["atlas"]}
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
                question={`remove “${highlighted.name}” from atlas?`}
                detail={removalCost(highlighted.jobCount)}
                confirmLabel="remove"
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
        show={all.length === 0 && mode !== "open"}
        headline="No projects yet."
        hint="Atlas works inside a folder — usually a git repo."
      />
      <NoMatch show={all.length > 0 && rows.length === 0} query={query} />

      {rows.map((project, index) => (
        <text key={project.id}>
          <Caret on={index === cursor} />
          <span>{fitColumn(project.name, layout.name)}</span>
          {/* Clipped from the FRONT: `…/work/atlas` says which folder this is, `/Users/dennis/D…`
              says which machine it is on, and every row would say the same thing. */}
          {layout.path > 0 ? (
            <span fg={theme.dim}>
              {fitColumnEnd(shortenHome({ path: project.path, home: HOME }), layout.path)}
            </span>
          ) : null}
          {/* Working displaces the job count rather than sitting beside it: when an agent is
              running inside, that is the more useful thing to know, and the columns stay put. */}
          {working.includes(project.id) ? (
            <span fg={theme.accent}>{frame} working…</span>
          ) : project.exists ? (
            <span fg={theme.dim}>{jobLabel(project.jobCount)}</span>
          ) : (
            /* A missing path stays VISIBLE — a moved repo should be a decision, not a mystery. */
            <span fg={theme.warn}>{glyph.warning} path missing</span>
          )}
        </text>
      ))}

      <text> </text>
      <AddRow selected={cursor >= rows.length} label="+ open a folder…" />
    </Screen>
  );
}

/** Read once: the home directory cannot change under a running terminal. */
const HOME = process.env.HOME ?? "";

const HINTS = [
  "↑↓ select · →/⏎ open · / filter · n add · x remove · ? keys · ctrl+c quit",
  "↑↓ select · ⏎ open · / filter · n add · x remove · ? keys",
  "⏎ open · / filter · n add · ? keys",
];

/** Only these two modes borrow the footer's composer, and each says something different about ⏎. */
const OVERLAYS: Partial<Record<Mode, { placeholder: string; caption: string }>> =
  {
    open: {
      placeholder: "~/Developer/…",
      caption: "⏎ open · esc cancel",
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
