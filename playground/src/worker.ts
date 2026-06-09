import { botById, resolveWorkerModel, ROSTER } from './employees/index.js';
import { ROOT, withActiveRoot } from './engines/guard.js';
import { appendJobProgress, getJob, getJobProgress, updateJob } from './jobs.js';
import { logWork } from './memory/worklog.js';
import { workerPromptFor } from './persona.js';
import { localRuntime } from './runtime.js';
import { acquireWorkspace, releaseWorkspace, type Workspace } from './workspace.js';

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

// Live worktrees for in-flight EXECUTE jobs, keyed by job id. Job-scoped, NOT turn-scoped: a job that
// parks in 'awaiting' keeps its worktree so the resume turn continues on the same branch (re-acquiring
// would collide on the existing branch and lose its uncommitted work). Released on terminal status.
const workspaces = new Map<string, Workspace>();

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
  try {
    const bot = botById(job.ownerBot) ?? ROSTER[0];
    // Per-phase model tiering: PLAN runs on a high-reasoning model + max effort; EXECUTE on the cheaper
    // everyday model. `planning` makes the plan pass read-only at the engine seam.
    const { model, effort } = resolveWorkerModel(bot, job.mode);

    // EXECUTE jobs run in their own git worktree + branch — isolated from the trunk and from each
    // other, so an employee can have several workers building at once. PLAN jobs are read-only and run
    // on the trunk (ROOT). Reuse the worktree on a resume turn (an 'awaiting' job kept it); acquire one
    // on the first execute turn.
    let workspace = workspaces.get(jobId);
    if (job.mode === 'execute' && !workspace) {
      workspace = await acquireWorkspace(job);
      workspaces.set(jobId, workspace);
      updateJob(jobId, { branch: workspace.branch, workspacePath: workspace.path });
    }
    const cwd = workspace?.path ?? ROOT;

    process.stderr.write(
      `[worker:${jobId}] ${bot.name} ${job.mode} on ${model ?? `${job.engine} default`}${effort ? ` (effort:${effort})` : ''}${workspace ? ` @ ${workspace.branch}` : ''}\n`,
    );
    // Jail the in-process langgraph tools to this worktree for the duration of the run (claude/codex
    // additionally receive `cwd` for their own subprocess sandbox). Outside this scope tools fall back
    // to ROOT.
    const { result, sessionId } = await withActiveRoot(cwd, () =>
      localRuntime.run(job.engine, {
        task: message,
        cwd,
        systemPrompt: workerPromptFor(bot, job.mode),
        sessionId: job.sessionId,
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
    const report = result || '(no report)';
    const status = statusFromReport(report);
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
    // Release the worktree once the job is truly finished. An 'awaiting' job keeps it for the resume
    // turn; a terminal job (done/failed/cancelled) lets it go — keeping the branch (its commits / PR).
    const workspace = workspaces.get(jobId);
    if (workspace && getJob(jobId)?.status !== 'awaiting') {
      workspaces.delete(jobId);
      await releaseWorkspace(workspace).catch(() => {});
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
  if (controller) {
    // Running: abort the worker; its finally tears down the worktree (the status is now terminal).
    controller.abort();
  } else {
    // Awaiting (no live worker): release the parked worktree here, since no finally will run for it.
    const workspace = workspaces.get(jobId);
    if (workspace) {
      workspaces.delete(jobId);
      void releaseWorkspace(workspace).catch(() => {});
    }
  }
  updateJob(jobId, { status: 'cancelled' });
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
