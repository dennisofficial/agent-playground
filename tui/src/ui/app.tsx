import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useInput } from "./hooks/use-input.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectRow } from "../app/workspace.service.js";
import type { Thread } from "../generated/prisma/client.js";
import type { JobRow } from "../store/job.repository.js";
import { CopyNoticeProvider, useCopyOnSelect } from "./copy-on-select.js";
import { useRunningThreads } from "./hooks/use-conversation.js";
import { useNavigation, type ThreadsRoute } from "./navigation.js";
import { AccountsPage } from "./pages/accounts.js";
import { ConversationPage } from "./pages/conversation.js";
import { JobsPage } from "./pages/jobs.js";
import { ProjectsPage } from "./pages/projects.js";
import { ThreadsPage } from "./pages/threads.js";
import { useServices } from "./services.js";
import { glyph, theme } from "./theme.js";

export function App(props: {
  explicitPath: string | null;
  cwd: string;
}): React.ReactNode {
  const { workspaceService, conversationService } = useServices();
  const renderer = useRenderer();
  const { width: columns, height: rows } = useTerminalDimensions();
  const nav = useNavigation();
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  // Quitting with agents still working is the one exit that loses real work, so it asks twice.
  const running = useRunningThreads();
  const [armed, setArmed] = useState(false);
  // Here rather than on a page: we hold the mouse for the whole app, so we owe the clipboard for the
  // whole app. The composer of whichever page is mounted draws the confirmation.
  const copied = useCopyOnSelect();

  // Where the cursor was, so coming back from a job lands on the row you left rather than row zero.
  // A ref rather than route state: it is a hint for the next mount, not part of where you are.
  const focus = useRef<{ project?: string; job?: string }>({});

  // A failure belongs to the page that produced it. Leaving that page clears it, so an error can
  // never outlive the thing it was about.
  useEffect(() => setError(null), [nav.route]);

  // Armed is a moment, not a mode. Left standing it would turn a later, innocent ctrl+c into an
  // unwarned quit — the exact thing the warning exists to prevent.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  // `atlas` inside a repository lands on that repository's jobs, not on a picker. Launched anywhere
  // else — `~`, most often, because the tiles are long-lived and nobody cds between tickets — it
  // resolves to nothing and the full list stands. cwd biases; it never gates.
  useEffect(() => {
    void workspaceService
      .resolveLaunch({ explicitPath: props.explicitPath, cwd: props.cwd })
      .then((row) => {
        if (!row) return;
        // Pushed, not replaced: esc from there still reaches the project list.
        focus.current.project = row.id;
        nav.push({ name: "jobs", project: row });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBooting(false));
    // `nav` is deliberately not a dependency: its identity changes on every push, and re-running
    // this would re-open the folder and push a second jobs page onto the stack.
  }, [props.explicitPath, props.cwd, workspaceService]);

  const openJob = useCallback(
    async (project: ProjectRow, job: JobRow) => {
      try {
        // Nothing runs without auth — send the user to add an account rather than failing a turn.
        if (!(await workspaceService.hasAccount())) {
          nav.push({ name: "accounts" });
          return;
        }
        focus.current.job = job.id;
        // A job that took a worktree runs there, not in the tree the editor is open on. A job that
        // did not gets `project.path` back, exactly as before.
        const cwd = workspaceService.cwdFor({ job, projectPath: project.path });
        const open = await conversationService.openJob(job, cwd);
        // TWO frames, landing on the conversation. Descending skips the thread list because you
        // almost always want the live thread; ascending walks back through it because that is where
        // the job itself is managed. Leaving it underneath is what makes `←` mean "manage this job"
        // rather than "leave it", and `pop` unwinds the circle with no special case anywhere.
        nav.push(
          {
            name: "threads",
            project,
            job,
            cwd,
            currentThreadId: open.thread.id,
          },
          { name: "conversation", project, open },
        );
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [conversationService, nav, workspaceService],
  );

  // The soft lock says "another Atlas has this thread", so holding it while the user browses jobs
  // would wedge a second instance into read-only for no reason. A turn still in flight keeps it.
  const leaveConversation = useCallback(() => {
    void conversationService.leave().finally(() => nav.pop());
  }, [conversationService, nav]);

  /**
   * Switch the conversation to another thread of the same job. Neither side's turn is disturbed:
   * `leave()` releases the soft lock only when nothing is running, and `openThread()` HYDRATES the
   * store the destination already has rather than resetting it — a reset would blank a working
   * agent's spinner, tail and steer queue.
   */
  const switchThread = useCallback(
    async (args: { route: ThreadsRoute; thread: Thread }) => {
      const { route, thread } = args;
      try {
        await conversationService.leave();
        const open = await conversationService.openThread(
          route.job,
          thread,
          route.cwd,
        );
        // Replace THEN push: the thread list stays underneath, but re-stamped with the thread you
        // just chose, so coming back lands the cursor where you actually are. A plain push would
        // leave it naming the thread you opened the job on.
        //
        // One conversation frame in the stack, always — guaranteed here by structure rather than by
        // a special stack op: this page is only ever reached by popping the conversation off first.
        nav.replace({ ...route, currentThreadId: thread.id });
        nav.push({ name: "conversation", project: route.project, open });
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [conversationService, nav],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // Turns are subprocesses of this process, so quitting kills them. Say so once before doing it.
      if (running.length > 0 && !armed) {
        setArmed(true);
        return;
      }
      void conversationService.release().finally(() => renderer.destroy());
      return;
    }

    // Any other key means you are still working — the warning has served its purpose.
    if (armed) setArmed(false);

    // Toggle rather than push: pressing it twice returns you to where you were instead of stacking
    // a second accounts page you then have to escape out of twice.
    if (key.ctrl && input === "a") nav.toggle({ name: "accounts" });
  });

  // Even the boot frame claims the whole buffer, so the first paint is the app rather than a line
  // of text that the real layout then shoves around.
  if (booting) {
    return (
      <box flexDirection="column" width={columns} height={rows}>
        <text fg={theme.dim}>starting atlas…</text>
      </box>
    );
  }

  const route = nav.route;

  return (
    <CopyNoticeProvider notice={copied}>
      <box flexDirection="column" width={columns} height={rows}>
        {/* flexShrink={0}: a page full of transcript would otherwise shrink this to nothing. */}
        {error ? (
          <box flexDirection="row" flexShrink={0}>
            <text fg={theme.error}>{error}</text>
          </box>
        ) : null}

        {armed ? (
          <box flexDirection="row" flexShrink={0}>
            <text fg={theme.warn}>
              {glyph.warning} {agentsWorking(running.length)} · ctrl+c again to
              quit
            </text>
          </box>
        ) : null}

        {route.name === "projects" ? (
          <ProjectsPage
            focusId={focus.current.project}
            onOpen={(project) => {
              focus.current.project = project.id;
              nav.push({ name: "jobs", project });
            }}
          />
        ) : null}

        {route.name === "jobs" ? (
          <JobsPage
            project={route.project}
            focusId={focus.current.job}
            onOpen={(job) => void openJob(route.project, job)}
            onBack={nav.pop}
          />
        ) : null}

        {route.name === "conversation" ? (
          <ConversationPage
            open={route.open}
            onBack={leaveConversation}
            // The same door as `←`, not a second one: the thread list is already the frame beneath
            // this. Pushing another would stack two of them. It keeps its own key because the
            // TRIGGERS differ — `←` only leaves on an empty composer, `ctrl+h` always does.
            onThreads={leaveConversation}
          />
        ) : null}

        {route.name === "threads" ? (
          <ThreadsPage
            job={route.job}
            projectName={route.project.name}
            currentThreadId={route.currentThreadId}
            onOpen={(thread) => void switchThread({ route, thread })}
            onBack={nav.pop}
          />
        ) : null}

        {route.name === "accounts" ? <AccountsPage onBack={nav.pop} /> : null}
      </box>
    </CopyNoticeProvider>
  );
}

function agentsWorking(count: number): string {
  return count === 1
    ? "1 agent still working"
    : `${count} agents still working`;
}
