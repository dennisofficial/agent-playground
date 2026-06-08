import { ROOT } from './engines/guard.js';
import { getEngine } from './engines/index.js';
import { appendJobProgress, getJob, getJobProgress, updateJob } from './jobs.js';
import { logWork } from './memory/worklog.js';
import { workerPromptFor } from './persona.js';
import { botById, ROSTER } from './roster.js';

// Zero's background-execution thread. A dispatched task runs to completion on its engine (the engine
// loops internally until done), streams normalized events into the progress buffer, and reports ONCE
// — marking the job 'done' (or 'awaiting' only if it explicitly needs human input). That single
// `updateJob` is the wake signal the conductor relays through Zero. continueWork resumes the rare
// 'awaiting' case; there is no step-by-step check-in loop.

/** Hard cap on background turns per job — backstop against an endless continue↔report ping-pong. */
export const MAX_TURNS = 25;

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

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
  try {
    const { result, sessionId } = await getEngine(job.engine).run({
      task: message,
      cwd: ROOT,
      systemPrompt: workerPromptFor(job.engine, botById(job.ownerBot) ?? ROSTER[0]),
      sessionId: job.sessionId,
      onEvent: (e) => appendJobProgress(jobId, e),
    });
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
      logWork({ ownerBot: job.ownerBot, company: job.company, task: job.task, summary: report.slice(0, 600) });
    }
  } catch (err) {
    updateJob(jobId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
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
  updateJob(jobId, { status: 'running' });
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
