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
import {
  affords,
  elasticColumn,
  fitColumn,
  fitColumnEnd,
} from "../../domain/list-columns.js";
import { fitHints } from "../../domain/hints.js";
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
  const [working, setWorking] = useState<string[]>([]);
  // A filter and a folder path, never a draft: one line.
  const composer = useComposer("", { singleLine: true });

  const running = useRunningThreads();
  const { frame } = useTick(running.length > 0);

  const reload = useCallback(async () => {
    setProjects(await workspaceService.listProjects());
  }, [workspaceService]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Activity two levels down still belongs at the top: from here you should be able to see that
  // something is running without opening the project to find out. `running` is a stable snapshot,
  // so this fires only when the set of working threads actually changes.
  useEffect(() => {
    if (running.length === 0) {
      setWorking([]);
      return;
    }
    let live = true;
    void workspaceService.projectsWithRunningThreads(running).then((ids) => {
      if (live) setWorking(ids);
    });
    return () => {
      live = false;
    };
  }, [running, workspaceService]);

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
        <box flexDirection="column">
          {mode === "open" ? (
            <box flexDirection="column">
              <Composer
                state={composer.state}
                width={composerWidth(width)}
                placeholder="~/Developer/…"
                onCaret={composer.setCursor}
              />
              <text fg={theme.dim}>{"  "}⏎ open · esc cancel</text>
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
              question={`remove “${highlighted.name}” from atlas?`}
              detail={removalCost(highlighted.jobCount)}
              confirmLabel="remove"
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
      {all.length === 0 && mode !== "open" ? (
        <box flexDirection="column">
          <text>No projects yet.</text>
          <text fg={theme.dim}>
            Atlas works inside a folder — usually a git repo.
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

      {rows.map((project, index) => (
        <text key={project.id}>
          {index === cursor ? (
            <span fg={theme.accent}>{`  ${glyph.selected} `}</span>
          ) : (
            "    "
          )}
          <span>{fitColumn(project.name, layout.name)}</span>
          {/* Clipped from the FRONT: `…/work/atlas` says which folder this is, `/Users/dennis/D…`
              says which machine it is on, and every row would say the same thing. */}
          {layout.path > 0 ? (
            <span fg={theme.dim}>
              {fitColumnEnd(shortenHome(project.path), layout.path)}
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
      <text>
        {cursor >= rows.length ? (
          <span fg={theme.accent}>{`  ${glyph.selected} `}</span>
        ) : (
          "    "
        )}
        <span fg={theme.dim}>+ open a folder…</span>
      </text>
    </Screen>
  );
}

/** The confirm has to say what actually goes — and, just as importantly, what does not. */
function removalCost(jobCount: number): string {
  const jobs =
    jobCount === 0
      ? "no jobs to lose"
      : `${jobLabel(jobCount)} and their transcripts go with it`;
  return `${jobs} · the folder on disk is untouched`;
}

const HINTS = [
  "↑↓ select · →/⏎ open · / filter · n add · x remove · ? keys · ctrl+c quit",
  "↑↓ select · ⏎ open · / filter · n add · x remove · ? keys",
  "⏎ open · / filter · n add · ? keys",
];

/** A bordered box does not wrap: wider than the terminal and it draws off the edge. */
function composerWidth(width: number): number {
  return Math.min(72, width - 2);
}

/** `  ▸ `, and the trailing state — `⚠ path missing` is the widest thing that can land there. */
const GUTTER = 4;
const TAIL = 15;
const MARGIN = 2;
const NAME = { min: 12, max: 28 };
const PATH = { min: 16, max: 52 };

function projectsLayout(width: number): { name: number; path: number } {
  const room = Math.max(0, width - GUTTER - TAIL - MARGIN);
  // The name grows only while the path can still keep its minimum; past that they share.
  const name = elasticColumn(room, PATH.min, NAME);
  if (!affords(room, name, PATH.min)) {
    return { name: elasticColumn(room, 0, { min: 8, max: 40 }), path: 0 };
  }
  return { name, path: elasticColumn(room, name, PATH) };
}

function jobLabel(count: number): string {
  if (count === 0) return "—";
  return count === 1 ? "1 job" : `${count} jobs`;
}

function shortenHome(path: string): string {
  const home = process.env.HOME ?? "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
