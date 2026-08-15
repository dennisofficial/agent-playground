import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useInput } from "./hooks/use-input.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenConversation } from "../app/conversation.service.js";
import type { ProjectRow } from "../app/workspace.service.js";
import type { Thread } from "../generated/prisma/client.js";
import type { JobRow } from "../store/job.repository.js";
import { CopyNoticeProvider, useCopyOnSelect } from "./copy-on-select.js";
import { useCursorFollow } from "./hooks/use-cursor-follow.js";
import { useRunningThreads } from "./hooks/use-conversation.js";
import { useNewJob } from "./hooks/use-new-job.js";
import { useQuitGuard } from "./hooks/use-quit-guard.js";
import { claimService, useClaim } from "./hooks/use-claim.js";
import { EClaimState } from "../domain/claim.js";
import { mayStillBeAlive } from "../domain/services.js";
import { heldJobId, useNavigation, type ThreadsRoute } from "./navigation.js";
import { AccountsPage } from "./pages/accounts.js";
import { ConversationPage } from "./pages/conversation.js";
import { JobsPage } from "./pages/jobs.js";
import { NewJobPage } from "./pages/new-job.js";
import { ProjectsPage } from "./pages/projects.js";
import { ServicesPage } from "./pages/services.js";
import { ThreadsPage } from "./pages/threads.js";
import { useServices } from "./services.js";
import { glyph, theme } from "./theme.js";

export function App(props: {
  explicitPath: string | null;
  cwd: string;
}): React.ReactNode {
  const { workspaceService, conversationService, serviceRegistryService } =
    useServices();
  const renderer = useRenderer();
  const { width: columns, height: rows } = useTerminalDimensions();
  const nav = useNavigation();
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const running = useRunningThreads();
  // Quitting kills every working turn AND every service, so it asks once first. See `useQuitGuard`.
  //
  // `mayStillBeAlive`, not `isRunning`: what the warning has to name is what the reaper will have to
  // kill on the way out, and a group that ignored an earlier SIGTERM is `killed` in memory while it
  // is very much still there. Counting only `running` would go quiet about the one process the quit
  // is going to have to insist on.
  const armed = useQuitGuard({
    agents: running.length,
    services: () =>
      serviceRegistryService.allServices().filter(mayStillBeAlive).length,
    onQuit: () =>
      void conversationService.release().finally(() => renderer.destroy()),
  });
  // Here rather than on a page: we hold the mouse for the whole app, so we owe the clipboard for the
  // whole app. The composer of whichever page is mounted draws the confirmation.
  const copied = useCopyOnSelect();

  // Where the cursor was, so coming back from a job lands on the row you left rather than row zero.
  // A ref rather than route state: it is a hint for the next mount, not part of where you are.
  const focus = useRef<{ project?: string; job?: string }>({});

  // A job another terminal is holding, waiting for a second press to take it.
  const [takeover, setTakeover] = useState<{
    jobId: string;
    tty: string | null;
  } | null>(null);

  // Which pages count as being IN a job — see `heldJobId`.
  const held = heldJobId(nav.route);

  const handleTakenOver = useCallback(() => {
    if (!held) return;
    // Interrupt FIRST, navigate second. `←` deliberately leaves an agent working, so popping alone
    // would leave this tile streaming into a transcript the other terminal is now also writing.
    void conversationService.abandonJob(held).finally(() => {
      setError("this job was taken over by another terminal");
      nav.popTo("jobs");
    });
  }, [conversationService, held, nav]);

  useClaim({ jobId: held, onTakenOver: handleTakenOver });

  // Creating a job is two moves — a blank page, then the message that makes it real. Both live in
  // one hook because both are decisions about the STACK, and neither is wiring.
  const { handleNew, handleStart } = useNewJob({ nav, focus, onError: setError });

  // A failure belongs to the page that produced it. Leaving that page clears it, so an error can
  // never outlive the thing it was about.
  useEffect(() => setError(null), [nav.route]);

  // `atlas` inside a repository lands on that repository's jobs, not on a picker. Launched anywhere
  // else — `~`, most often, because the tiles are long-lived and nobody cds between tickets — it
  // resolves to nothing and the full list stands. cwd biases; it never gates.
  useEffect(() => {
    void workspaceService
      .resolveLaunch({ explicitPath: props.explicitPath, cwd: props.cwd })
      .then((row) => {
        if (!row) return;
        // REPLACES the root rather than stacking on it. `←` still widens to every job — it swaps the
        // scope on this one frame — and the list you launched into is therefore the bottom of the
        // stack, with no `‹` promising an exit that `pop` would have to refuse.
        focus.current.project = row.id;
        nav.replace({ name: "jobs", project: row });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBooting(false));
    // `nav` is deliberately not a dependency: its identity changes on every push, and re-running
    // this would re-open the folder and push a second jobs page onto the stack.
  }, [props.explicitPath, props.cwd, workspaceService]);

  const openJob = useCallback(
    async (job: JobRow, known: ProjectRow | null) => {
      try {
        // Nothing runs without auth — send the user to add an account rather than failing a turn.
        if (!(await workspaceService.hasAccount())) {
          nav.push({ name: "accounts" });
          return;
        }
        // Held elsewhere: arm rather than refuse, and rather than open a modal. One user, one
        // machine — taking a job back is a keypress, not a negotiation, and the same idiom already
        // guards quitting. The second press falls through because `takeover` now names this job.
        if (
          takeover?.jobId !== job.id &&
          claimService.stateOf(job.id) === EClaimState.held
        ) {
          setTakeover({ jobId: job.id, tty: claimService.read(job.id)?.tty ?? null });
          return;
        }
        setTakeover(null);
        // Acquired HERE, where opening the job is what you meant, rather than in a mount effect
        // that would take it from whoever had it just because a route appeared.
        claimService.acquire(job.id);
        // The unscoped list spans projects, so a row there arrives without one. The scoped list
        // already has it and hands it over rather than paying for the lookup again.
        const project = known ?? (await workspaceService.findProject(job.projectId));
        if (!project) throw new Error(`no project for “${job.title}”`);
        focus.current.job = job.id;
        // A job that took a worktree runs there, not in the tree the editor is open on. A job that
        // did not gets `project.path` back, exactly as before.
        const cwd = workspaceService.cwdFor({ job, projectPath: project.path });
        const open = await conversationService.openJob(job, cwd);
        // ONE frame: the conversation, which is what opening a job means. The job's own page is
        // above this, a `→` away, not underneath it — so `←` from here is the list you came from,
        // the same as `←` on every other page.
        //
        // Unless the cursor thread has CLOSED, which is what a shipped job looks like: there is no
        // live thread to land on, and a read-only transcript would stand between Dennis and the two
        // verbs that re-enter the job. Both live on the job's page, so open that instead.
        if (open.closed) {
          nav.push({
            name: "threads",
            project,
            job,
            cwd,
            currentThreadId: open.thread.id,
          });
          return;
        }
        nav.push({ name: "conversation", project, open });
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [conversationService, nav, takeover, workspaceService],
  );

  // The soft lock says "another Atlas has this thread", so holding it while the user browses jobs
  // would wedge a second instance into read-only for no reason. A turn still in flight keeps it.
  const leaveConversation = useCallback(() => {
    void conversationService.leave().finally(() => nav.pop());
  }, [conversationService, nav]);

  /**
   * Up from the conversation into the job itself — phases, threads, rename, worktree.
   *
   * The route is built HERE from the conversation rather than carried on it, so the job's page always
   * opens on the thread you are actually looking at. It used to be stamped when the job opened and
   * re-stamped on every thread switch; a frame that has not been pushed yet cannot go stale.
   */
  const openThreads = useCallback(() => {
    if (nav.route.name !== "conversation") return;
    const { project, open } = nav.route;
    nav.push({
      name: "threads",
      project,
      job: open.job,
      cwd: open.cwd,
      currentThreadId: open.thread.id,
    });
  }, [nav]);

  /**
   * Pushed, not toggled: `/services` is typed from a composer you are coming back to, and the
   * conversation underneath is exactly where `←` should land you.
   *
   * A `useCallback` over the route rather than an inline arrow, because the conversation page memos
   * its submit handler on this identity — an arrow rebuilt on every delta tick defeats that memo
   * thirty times a second while an agent is streaming. It reads the route itself for the same
   * reason `leaveConversation` does: the value it needs is only defined on the route it fires from.
   */
  const openServices = useCallback(() => {
    if (nav.route.name !== "conversation") return;
    const { job } = nav.route.open;
    nav.push({ name: "services", jobId: job.id, jobTitle: job.title });
  }, [nav]);

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
        // Unwind to the list, then descend into the thread you chose. Choosing a thread is not a step
        // DEEPER than the job's page — it is the same one move as opening the job, made again with a
        // different thread — so the stack it leaves behind has to be the same one opening the job
        // leaves: list, then conversation. Rewinding is also what makes the two arrival paths agree,
        // since this page is reached both from a conversation and (for a shipped job) straight from
        // the list, and popping a fixed count would be right for only one of them.
        nav.popTo("jobs");
        nav.push({ name: "conversation", project: route.project, open });
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [conversationService, nav],
  );

  /**
   * The cursor moved out from under the page, or the thread on it closed mid-turn. Both are one act
   * — swap the conversation frame for what the job now points at.
   *
   * The frame REPLACES rather than pushes, so `←` still walks back to the job. Only the top frame
   * moves: the thread list underneath re-reads the cursor itself when it mounts.
   */
  const showConversation = useCallback(
    (open: OpenConversation) => {
      if (nav.route.name !== "conversation") return;
      nav.replace({ name: "conversation", project: nav.route.project, open });
    },
    [nav],
  );

  useCursorFollow({
    open: nav.route.name === "conversation" ? nav.route.open : null,
    onMoved: (thread) => {
      if (nav.route.name !== "conversation") return;
      const { job, cwd } = nav.route.open;
      void conversationService
        .openThread(job, thread, cwd)
        .then(showConversation)
        .catch((e: Error) => setError(e.message));
    },
    onRefreshed: showConversation,
  });

  /**
   * Move a job out of the project path and into its own worktree, at any point in its life.
   *
   * `cwd` is where the next thread opened from this page will run, so this page is re-stamped with
   * the new tree — leaving the old value would open the next thread in the very tree the worktree was
   * taken to stay out of. The conversation UNDERNEATH carries the same stale path and cannot be
   * re-stamped from here, so the stack is rebuilt instead of replaced: taking a worktree is a rare,
   * deliberate, once-per-job act, and dropping you onto the job's page after it is both honest about
   * what moved and exactly where the verbs you want next already are.
   */
  const enterWorktree = useCallback(
    async (route: ThreadsRoute) => {
      try {
        const workspace = await workspaceService.enterWorktree(route.job.id);
        const job = await workspaceService.findJob(route.job.id);
        nav.popTo("jobs");
        nav.push({
          ...route,
          ...(job ? { job } : {}),
          cwd: workspace.workspacePath,
        });
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [nav, workspaceService],
  );

  useInput((input, key) => {
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
              {glyph.warning} {armed} · ctrl+c again to quit
            </text>
          </box>
        ) : null}

        {/* Deliberately not a modal. Taking a job back is one keypress, and a dialog for it would
            be three. It cannot say whether a turn is running over there — turns are in-process, so
            this terminal cannot see another's — which is exactly why the displaced tile interrupts
            its own work rather than being asked to promise it has none. */}
        {takeover ? (
          <box flexDirection="row" flexShrink={0}>
            <text fg={theme.warn}>
              {glyph.warning} open in another terminal
              {takeover.tty ? ` (${takeover.tty})` : ""} · ⏎ again to take it
            </text>
          </box>
        ) : null}

        {route.name === "projects" ? (
          <ProjectsPage
            focusId={focus.current.project}
            // A switcher, not a level: this RESETS to the scoped list rather than pushing it, so
            // choosing the project you are already in cannot leave a second copy of the list you are
            // looking at two frames below it. That was the whole of the `p` weirdness.
            onOpen={(project) => {
              focus.current.project = project.id;
              nav.reset({ name: "jobs", project });
            }}
            onBack={nav.pop}
          />
        ) : null}

        {route.name === "jobs" ? (
          <JobsPage
            // Scope changes by REPLACE, so this page stays mounted across one — and its cursor, its
            // filter and its shelf all belong to the list it was showing. Remount rather than reset
            // four pieces of state and have to remember the fifth.
            key={route.project?.id ?? "all"}
            project={route.project}
            focusId={focus.current.job}
            onOpen={(job) => void openJob(job, route.project)}
            // Unreachable unscoped — the page hides `new job` when it has no project to create it
            // in — but a job has to be created SOMEWHERE, and the check is what says so.
            onNew={(adopt) => {
              if (route.project) void handleNew(route.project, adopt);
            }}
            // Toggle rather than push, the same as `ctrl+a`: `p` twice returns you to the list
            // instead of stacking a switcher you then have to escape out of.
            onProjects={() => nav.toggle({ name: "projects" })}
            // `←` on a scoped list WIDENS it — one frame, one scope swap. At the unscoped list there
            // is nothing wider, so the key does nothing and the header draws no `‹` to suggest it
            // might. Popping here would have been the one `←` in the app with nowhere to go.
            onBack={() => {
              if (route.project) nav.replace({ name: "jobs", project: null });
            }}
          />
        ) : null}

        {route.name === "new-job" ? (
          <NewJobPage
            projectName={route.project.name}
            worktree={route.adopt?.branch}
            onSubmit={(text) =>
              handleStart({
                project: route.project,
                text,
                ...(route.adopt ? { adopt: route.adopt } : {}),
              })
            }
            onCancel={nav.pop}
          />
        ) : null}

        {route.name === "conversation" ? (
          <ConversationPage
            open={route.open}
            onBack={leaveConversation}
            // A different door from `←`, and now a deeper one: the job's page is above this, so this
            // pushes where `←` pops. Two keys reach it because the TRIGGERS differ — `→` only
            // descends on an empty composer, `ctrl+h` always does.
            onThreads={openThreads}
            onServices={openServices}
          />
        ) : null}

        {route.name === "threads" ? (
          <ThreadsPage
            job={route.job}
            projectName={route.project.name}
            currentThreadId={route.currentThreadId}
            // Where a thread started from this page runs. The route's, not the project's: a job that
            // took a worktree must not open its next thread in the tree the worktree exists to
            // stay out of.
            cwd={route.cwd}
            onOpen={(thread) => void switchThread({ route, thread })}
            onEnterWorktree={() => void enterWorktree(route)}
            onBack={nav.pop}
          />
        ) : null}

        {/* NO reap keyed off this route, and none keyed off a claim release either. This page holds
            the claim (`heldJobId`), but the accounts page does not — and a reap on that transition
            would SIGTERM a dev server because the human pressed ctrl+a. */}
        {route.name === "services" ? (
          <ServicesPage
            jobId={route.jobId}
            jobTitle={route.jobTitle}
            onBack={nav.pop}
          />
        ) : null}

        {route.name === "accounts" ? <AccountsPage onBack={nav.pop} /> : null}
      </box>
    </CopyNoticeProvider>
  );
}

