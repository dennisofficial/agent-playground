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
import { projectsLayout, removalCost } from "../../domain/projects-list.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import {
  ListFooter,
  type FooterOverlay,
} from "../components/list-footer.js";
import { AddRow, ListEmpty, NoMatch } from "../components/list-parts.js";
import { ProjectListRow } from "../components/project-list.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { useComposer, type ComposerControls } from "../hooks/use-composer.js";
import { useRunningThreads, useTick } from "../hooks/use-conversation.js";
import { useProjectAttention } from "../hooks/use-project-attention.js";
import { useServices } from "../services.js";
import { theme } from "../theme.js";

/** What the page is waiting for. Exactly one of these owns the keyboard at a time. */
type Mode = "browse" | "filter" | "open" | "confirm";

/**
 * The project switcher, and the housekeeping that goes with it.
 *
 * Not a level you navigate through: the job list already spans every project, so this is opened from
 * that list and choosing a project puts you back on it, scoped — see `onOpen` at the call site. It
 * is reached and dismissed by the same `p`, the way the accounts page is by `ctrl+a`.
 */
export function ProjectsPage(props: {
  /** The project last opened — the cursor lands on it when you come back, not on row zero. */
  focusId?: string | undefined;
  onOpen: (project: ProjectRow) => void;
  /** Back to the list this was opened from, with the scope untouched. */
  onBack: () => void;
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
  // The same union a job runs over its threads, one level up: a project says what needs you
  // without your having to open it to find out.
  const attentionFor = useProjectAttention(running);
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

    // Three ways out, all meaning the same thing, because this page is a detour rather than a step:
    // `←`/`esc` as on every list, and `p` again — the key that opened it.
    if (key.escape || key.leftArrow || input === "p") return props.onBack();
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
      <Screen header={<PageHeader trail={["projects"]} canBack />}>
        <text fg={theme.dim}>loading…</text>
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <PageHeader
          // "projects" rather than "atlas": every page is atlas, and this one is a detour with a way
          // back, so the `‹` is the honest part of the line.
          trail={["projects"]}
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
        <ProjectListRow
          key={project.id}
          project={project}
          attention={attentionFor(project.id)}
          selected={index === cursor}
          layout={layout}
          frame={frame}
        />
      ))}

      <text> </text>
      <AddRow selected={cursor >= rows.length} label="+ open a folder…" />
    </Screen>
  );
}

const HINTS = [
  "↑↓ select · →/⏎ switch to · / filter · n add · x remove · ←/esc back · ? keys",
  "↑↓ select · ⏎ switch to · / filter · n add · x remove · esc back",
  "⏎ switch · / filter · n add · esc back",
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
