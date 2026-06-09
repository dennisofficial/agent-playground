import { botById, resolveWorkerModel, ROSTER } from './employees/index.js';
import { ROOT, withActiveRoot } from './engines/guard.js';
import { appendJobProgress, getJob, getJobProgress, updateJob } from './jobs.js';
import { logWork } from './memory/worklog.js';
import { workerPromptFor } from './persona.js';
import { localRuntime } from './runtime.js';
import {
  acquireTicketWorkspace,
  acquireWorkspace,
  activeTicketWorkers,
  closeTicketWorkspace,
  publishToTicketBranch,
  releaseWorkspace,
  type Workspace,
} from './workspace.js';

// Zero's background-execution thread. A dispatched task runs to completion on its engine (the engine
// loops internally until done), streams normalized events into the progress buffer, and reports ONCE
// — marking the job 'done' (or 'awaiting' only if it explicitly needs human input). That single
// `updateJob` is the wake signal the conductor relays through Zero. continueWork resumes the rare
// 'awaiting' case; there is no step-by-step check-in loop.

/** Cap on background turns per job. TEMPORARILY UNCAPPED (2026-06-09, Dennis) — running jobs fully
 * autonomous to completion with no turn limit; `Infinity` makes the `job.turns >= MAX_TURNS` check never
 * fire. Restore to 100 when unattended operation needs a backstop (paired with the progress/cost breaker
 * in the conductor — see memory `agent-playground-autonomy-endgoal`). */
export const MAX_TURNS = Number.POSITIVE_INFINITY;

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

// Live AbortControllers for in-flight worker runs, keyed by job id — the handle `cancelJob` aborts.
// (In-process for now; when workers move to their own containers this becomes a remote stop signal.)
const controllers = new Map<string, AbortController>();

// Live per-job worktrees for NON-TICKET execute jobs (the human /approve path), keyed by job id;
// released on terminal status. Ticket execute jobs use the durable, ticket-scoped registry in
// workspace.ts instead (shared across a discipline's jobs and re-adopted on restart).
const workspaces = new Map<string, Workspace>();

// How many extra in-process resolve turns a worker gets to auto-heal a merge conflict integrating into
// the shared ticket branch before it parks 'awaiting' for a human. Self-heal first, escalate as fallback.
const MAX_RESOLVE_TURNS = 1;

/**
 * A finished run reports as 'done' — a background task runs all the way to completion and reports
 * ONCE; it does not check in after every step. The only exception: if it explicitly ended needing a
 * human (STATUS: QUESTION / BLOCKED) it parks in 'awaiting' so the chat-self can get input. Anything
 * else (DONE / PROGRESS / no status) is treated as complete.
 *
 * The worker ends its report with the status line, so only inspect the tail — a report can legitimately
 * mention "STATUS: …" in its body (e.g. when it summarizes this very codebase), which must not count.
 */
function statusFromReport(report: string): 'done' | 'awaiting' {
  const tail = report.trimEnd().split('\n').slice(-5).join('\n');
  const matches = [...tail.matchAll(/^[\s>*_-]*STATUS:\s*(DONE|BLOCKED|QUESTION|PROGRESS)\b/gim)];
  const tag = matches.at(-1)?.[1]?.toUpperCase();
  return tag === 'QUESTION' || tag === 'BLOCKED' ? 'awaiting' : 'done';
}

/**
 * Run a job's background thread to completion on its engine. `message` is the original task on the
 * first run, or the chat-self's answer when resuming an 'awaiting' job (resume is automatic once the
 * job has a sessionId). The engine already loops internally until the whole task is done, so this
 * reports once. Fire-and-forget — errors are caught here so there's never an unhandled rejection.
 */
export async function runWorkerTurn(jobId: string, message: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;
  const ac = new AbortController();
  controllers.set(jobId, ac);
  let workspace: Workspace | undefined; // declared out here so `finally` can tear it down
  try {
    const bot = botById(job.ownerBot) ?? ROSTER[0];
    // Per-phase model tiering: PLAN runs on a high-reasoning model + max effort; EXECUTE on the cheaper
    // everyday model. `planning` makes the plan pass read-only at the engine seam.
    const { model, effort } = resolveWorkerModel(bot, job.mode);

    // Resolve the worktree an EXECUTE job runs in. A TICKET job uses its shared, ticket-scoped worktree
    // (its own branch agent/<bot>/<TKT> off the shared ticket/<TKT> branch — reused across this
    // discipline's jobs, re-adopted on restart). A non-ticket job (the human /approve path) gets a
    // throwaway per-job worktree. PLAN jobs are read-only and run on the trunk (ROOT).
    if (job.mode === 'execute') {
      workspace = job.ticketId
        ? await acquireTicketWorkspace(job.ticketId, job.ownerBot)
        : (workspaces.get(jobId) ?? (await acquireWorkspace(job)));
      if (!job.ticketId) workspaces.set(jobId, workspace);
      updateJob(jobId, { branch: workspace.branch, workspacePath: workspace.path });
    }
    const cwd = workspace?.path ?? ROOT;

    // Run the engine to completion. For a TICKET execute job, a clean finish must be PUBLISHED to the
    // shared branch before we believe "done" — "done" means "integrated". A merge conflict buys the
    // worker one focused resolve turn (same worktree + session) before it escalates to a human.
    let currentMessage = message;
    let resumeSession = job.sessionId;
    let resolveTurns = 0;
    for (;;) {
      // Jail the in-process langgraph tools to this worktree for the run (claude/codex also get `cwd`
      // for their own subprocess sandbox). Outside this scope tools fall back to ROOT.
      process.stderr.write(
        `[worker:${jobId}] ${bot.name} ${job.mode} on ${model ?? `${job.engine} default`}${effort ? ` (effort:${effort})` : ''}${workspace ? ` @ ${workspace.branch}` : ''}${resolveTurns ? ' (resolving conflict)' : ''}\n`,
      );
      const { result, sessionId } = await withActiveRoot(cwd, () =>
        localRuntime.run(job.engine, {
          task: currentMessage,
          cwd,
          systemPrompt: workerPromptFor(bot, job.mode, workspace),
          sessionId: resumeSession,
          model,
          effort,
          planning: job.mode === 'plan',
          onEvent: (e) => appendJobProgress(jobId, e),
          signal: ac.signal,
          workspace,
        }),
      );
      // Cancelled while we were finishing up: discard the result, don't mark done or relay.
      if (ac.signal.aborted) return;
      resumeSession = sessionId;
      const report = result || '(no report)';
      const status = statusFromReport(report);

      // Ticket execute job that reports done: integrate it onto the shared branch before trusting it.
      if (status === 'done' && workspace?.ticketId) {
        const pub = await publishToTicketBranch(workspace);
        if (!pub.integrated) {
          if (resolveTurns < MAX_RESOLVE_TURNS) {
            resolveTurns++;
            currentMessage = `Your work hit a MERGE CONFLICT integrating into the shared ticket branch ${workspace.sharedBranch}${
              pub.files?.length ? ` (conflicts in: ${pub.files.join(', ')})` : ''
            }. A merge is in progress in your worktree with conflict markers. Resolve the conflicts — preserve BOTH sides' intent — then commit the merge and finish.`;
            continue; // one resolve turn, same worktree + session
          }
          // Couldn't auto-heal — park for a human; the relay surfaces it and the chat-self @mentions Dennis.
          updateJob(jobId, {
            status: 'awaiting',
            sessionId,
            lastReport: `${report}\n\nSTATUS: BLOCKED — couldn't auto-resolve a merge conflict integrating into ${workspace.sharedBranch}; need a human.`,
            turns: job.turns + 1,
          });
          return;
        }
      }

      updateJob(jobId, {
        status,
        sessionId,
        lastReport: report,
        turns: job.turns + 1,
        ...(status === 'done' ? { result: report } : {}),
      });
      // Record completed work to the durable log so standups / "what did you do" have a real answer.
      if (status === 'done') {
        logWork({
          ownerBot: job.ownerBot,
          project: job.project,
          task: job.task,
          summary: report.slice(0, 600),
        });
      }
      break;
    }
  } catch (err) {
    // An abort surfaces here as a thrown error — that's a cancellation, not a failure.
    if (ac.signal.aborted) updateJob(jobId, { status: 'cancelled' });
    else
      updateJob(jobId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
  } finally {
    controllers.delete(jobId);
    // Release worktrees once work is finished — but never out from under an 'awaiting' job (it keeps its
    // worktree for the resume turn).
    const status = getJob(jobId)?.status;
    if (status && status !== 'awaiting') {
      if (workspace?.ticketId && workspace.owner) {
        // Ticket worktree: close only when no other worker for this discipline is still live (a build
        // and an explore worker can share it). Branches are kept (commits live on them / the shared branch).
        if (activeTicketWorkers(workspace.ticketId, workspace.owner) === 0)
          await closeTicketWorkspace(workspace.ticketId, workspace.owner).catch(() => {});
      } else if (!workspace?.ticketId) {
        const ws = workspaces.get(jobId);
        if (ws) {
          workspaces.delete(jobId);
          await releaseWorkspace(ws).catch(() => {});
        }
      }
    }
  }
}

/**
 * Cancel a job the owner no longer wants: abort its running worker (the engine kills its child
 * process / aborts its stream) and mark it 'cancelled' so its result is discarded, not relayed. Works
 * on a 'running' job or one parked in 'awaiting'; a finished/failed/already-cancelled job is a no-op.
 */
export function cancelJob(jobId: string): ActionResult {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: `No job "${jobId}".` };
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')
    return { ok: false, reason: `${jobId} is already ${job.status} — nothing to cancel.` };
  const controller = controllers.get(jobId);
  updateJob(jobId, { status: 'cancelled' }); // mark first so worker-count checks exclude this job
  if (controller) {
    // Running: abort the worker; its finally tears down the worktree (the status is now terminal).
    controller.abort();
  } else if (job.ticketId) {
    // Awaiting ticket job: close this discipline's worktree if no other worker is still live on it.
    if (activeTicketWorkers(job.ticketId, job.ownerBot) === 0)
      void closeTicketWorkspace(job.ticketId, job.ownerBot).catch(() => {});
  } else {
    // Awaiting per-job: release the parked worktree here, since no finally will run for it.
    const workspace = workspaces.get(jobId);
    if (workspace) {
      workspaces.delete(jobId);
      void releaseWorkspace(workspace).catch(() => {});
    }
  }
  return { ok: true };
}

/**
 * Resume a task that came back needing input (an 'awaiting' job), feeding it the human's answer.
 * This is the ONLY way work continues past one run — there is no step-by-step continue loop. Guarded:
 * only an 'awaiting' job under the turn cap can be resumed.
 */
export function continueWork(jobId: string, note: string): ActionResult {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: `No job "${jobId}".` };
  if (job.status !== 'awaiting')
    return {
      ok: false,
      reason: `${jobId} is ${job.status}, not awaiting input — nothing to resume.`,
    };
  if (job.turns >= MAX_TURNS)
    return { ok: false, reason: `${jobId} reached its ${MAX_TURNS}-run limit.` };
  updateJob(jobId, { status: 'running', version: job.version + 1 });
  void runWorkerTurn(jobId, note);
  return { ok: true };
}

/**
 * Render a job's recent steps as a compact, narratable string for `check_job`. Reads the per-job
 * progress buffer (engine-independent). Kept async so existing `await getJobState(...)` callers are
 * unaffected.
 */
export async function getJobState(jobId: string): Promise<string> {
  const events = getJobProgress(jobId);
  if (events.length === 0) return 'No activity yet — just getting started.';

  const lines: string[] = [];
  for (const e of events.slice(-12)) {
    if (e.kind === 'text') lines.push(`thinking: ${e.text.slice(0, 200)}`);
    else if (e.kind === 'tool') lines.push(`→ called ${e.name}${e.detail ? ` (${e.detail})` : ''}`);
    else if (e.kind === 'result')
      lines.push(`  result: ${e.text.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n') || 'Working…';
}
